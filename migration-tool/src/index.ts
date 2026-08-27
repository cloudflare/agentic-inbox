interface Env {
  SOURCE_DB: D1Database;
  SOURCE_R2: R2Bucket;
  TARGET_R2: R2Bucket;
  TARGET_MAILBOX: DurableObjectNamespace;
  MIGRATION_TOKEN?: string;
  TARGET_WORKER_NAME?: string;
}

type SourceAccount = {
  account_id: number;
  email: string;
  name: string;
  user_id: number;
};

type SourceEmail = {
  email_id: number;
  send_email: string | null;
  name: string | null;
  account_id: number;
  user_id: number;
  subject: string | null;
  code: string | null;
  text: string | null;
  content: string | null;
  cc: string | null;
  bcc: string | null;
  recipient: string | null;
  to_email: string | null;
  to_name: string | null;
  in_reply_to: string | null;
  relation: string | null;
  message_id: string | null;
  type: number;
  status: number;
  resend_email_id: string | null;
  message: string | null;
  unread: number;
  create_time: string;
  is_del: number;
  is_starred?: number;
};

type SourceAttachment = {
  att_id: number;
  user_id: number;
  email_id: number;
  account_id: number;
  key: string;
  filename: string | null;
  mime_type: string | null;
  size: number | null;
  status: string | number | null;
  type: number | null;
  disposition: string | null;
  related: string | null;
  content_id: string | null;
  encoding: string | null;
  create_time: string;
};

const SEND = 1;
const RECEIVE = 0;
const BATCH_DEFAULT = 10;
const BATCH_MAX = 25;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function safeFilename(filename: string | null | undefined) {
  return (filename || "untitled").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 240) || "untitled";
}

function parseJsonList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        if (typeof item === "string") return item.trim().toLowerCase();
        if (item && typeof item === "object") return String((item as any).address || (item as any).email || "").trim().toLowerCase();
        return "";
      }).filter(Boolean);
    }
  } catch { /* old data occasionally contains malformed JSON */ }
  return value.split(/[;,]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function normalizeSubject(subject: string) {
  return String(subject || "")
    .replace(/^\s*((re|fw|fwd|回复|转发|aw|wg|réf|sv)\s*[:：]\s*)+/ig, "")
    .trim()
    .toLowerCase();
}

async function threadIdFor(email: SourceEmail) {
  const sender = String(email.send_email || "").trim().toLowerCase();
  const recipients = email.type === SEND
    ? parseJsonList(email.recipient)
    : [String(email.to_email || email.account_id || "").trim().toLowerCase()].filter(Boolean);
  const participants = [...new Set([sender, ...recipients].filter(Boolean))].sort().join(",");
  const raw = `${normalizeSubject(email.subject || "")}|${participants}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `legacy-${hex.slice(0, 32)}`;
}

function folderFor(email: SourceEmail, includeDeleted: boolean) {
  if (includeDeleted && email.is_del) return "trash";
  return email.type === SEND ? "sent" : "inbox";
}

function mailboxSettings(account: SourceAccount) {
  return {
    fromName: account.name || account.email.split("@")[0],
    forwarding: { enabled: false, email: "" },
    signature: { enabled: false, text: "" },
    autoReply: { enabled: false, subject: "", message: "" },
  };
}

async function ensureMailbox(env: Env, account: SourceAccount) {
  const email = account.email.trim().toLowerCase();
  const key = `mailboxes/${email}.json`;
  if (!(await env.TARGET_R2.head(key))) {
    await env.TARGET_R2.put(key, JSON.stringify(mailboxSettings(account)), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }
  const stub = env.TARGET_MAILBOX.get(env.TARGET_MAILBOX.idFromName(email)) as any;
  await stub.getFolders();
  return stub;
}

async function sourceAccounts(env: Env) {
  const result = await env.SOURCE_DB.prepare(
    `SELECT account_id, email, name, user_id
       FROM account
      WHERE is_del = 0
      ORDER BY account_id ASC`
  ).all<SourceAccount>();
  return result.results || [];
}

async function countEmails(env: Env, accountId: number, includeDeleted: boolean) {
  const where = includeDeleted ? "" : " AND is_del = 0";
  const row = await env.SOURCE_DB.prepare(
    `SELECT COUNT(*) AS total FROM email WHERE account_id = ? AND user_id = ? ${where}`
  ).bind(accountId, 0).first<{ total: number }>();
  // The user_id condition above is intentionally replaced below. Keeping the query
  // account-scoped is safer because account_id is the primary ownership boundary.
  if (row) return Number(row.total || 0);
  return 0;
}

async function loadBatch(env: Env, account: SourceAccount, cursor: number, batch: number, includeDeleted: boolean) {
  const deletedClause = includeDeleted ? "" : "AND e.is_del = 0";
  const result = await env.SOURCE_DB.prepare(
    `SELECT e.*,
            CASE WHEN EXISTS (
              SELECT 1 FROM star s WHERE s.email_id = e.email_id AND s.user_id = e.user_id
            ) THEN 1 ELSE 0 END AS is_starred
       FROM email e
      WHERE e.account_id = ?
        AND e.user_id = ?
        AND e.email_id > ?
        ${deletedClause}
        AND e.type IN (0, 1)
      ORDER BY e.email_id ASC
      LIMIT ?`
  ).bind(account.account_id, account.user_id, cursor, batch).all<SourceEmail>();
  return result.results || [];
}

async function loadAttachments(env: Env, emailIds: number[]) {
  if (!emailIds.length) return new Map<number, SourceAttachment[]>();
  const placeholders = emailIds.map(() => "?").join(",");
  const result = await env.SOURCE_DB.prepare(
    `SELECT * FROM attachments WHERE email_id IN (${placeholders}) ORDER BY att_id ASC`
  ).bind(...emailIds).all<SourceAttachment>();
  const map = new Map<number, SourceAttachment[]>();
  for (const row of result.results || []) {
    const list = map.get(row.email_id) || [];
    list.push(row);
    map.set(row.email_id, list);
  }
  return map;
}

async function migrateBatch(
  env: Env,
  account: SourceAccount,
  cursor: number,
  batch: number,
  includeDeleted: boolean,
  dryRun: boolean,
) {
  const rows = await loadBatch(env, account, cursor, batch, includeDeleted);
  const attachments = await loadAttachments(env, rows.map((r) => r.email_id));
  const stub = dryRun ? null : await ensureMailbox(env, account);

  let migrated = 0;
  let skipped = 0;
  let attachmentCopied = 0;
  let attachmentMissing = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const newId = `legacy-${account.account_id}-${row.email_id}`;
    const targetFolder = folderFor(row, includeDeleted);
    const existing = dryRun ? null : await stub.getEmail(newId);
    if (existing) {
      skipped++;
      continue;
    }

    const sender = String(row.send_email || account.email).trim().toLowerCase();
    const recipients = row.type === SEND
      ? parseJsonList(row.recipient)
      : [String(row.to_email || account.email).trim().toLowerCase()].filter(Boolean);
    const cc = parseJsonList(row.cc);
    const bcc = parseJsonList(row.bcc);
    const threadId = await threadIdFor(row);
    const body = row.content || row.text || "";
    const sourceAttachments = attachments.get(row.email_id) || [];
    const targetAttachments: any[] = [];

    if (!dryRun) {
      for (const att of sourceAttachments) {
        const sourceKey = String(att.key || "");
        if (!sourceKey) continue;
        const sourceObject = await env.SOURCE_R2.get(sourceKey);
        if (!sourceObject) {
          attachmentMissing++;
          errors.push(`Attachment missing: email ${row.email_id}, ${sourceKey}`);
          continue;
        }
        const attachmentId = `legacy-${att.att_id}`;
        const filename = safeFilename(att.filename);
        const targetKey = `attachments/${newId}/${attachmentId}/${filename}`;
        await env.TARGET_R2.put(targetKey, sourceObject.body, {
          httpMetadata: { contentType: att.mime_type || "application/octet-stream" },
        });
        targetAttachments.push({
          id: attachmentId,
          email_id: newId,
          filename,
          mimetype: att.mime_type || "application/octet-stream",
          size: Number(att.size || sourceObject.size || 0),
          content_id: att.content_id || null,
          disposition: att.disposition || (att.type === 1 ? "inline" : "attachment"),
        });
        attachmentCopied++;
      }
    }

    const rawHeaders = JSON.stringify([
      { key: "from", value: sender },
      { key: "to", value: recipients.join(", ") },
      ...(cc.length ? [{ key: "cc", value: cc.join(", ") }] : []),
      ...(bcc.length ? [{ key: "bcc", value: bcc.join(", ") }] : []),
      { key: "subject", value: row.subject || "" },
      { key: "date", value: row.create_time },
      ...(row.message_id ? [{ key: "message-id", value: row.message_id }] : []),
      ...(row.in_reply_to ? [{ key: "in-reply-to", value: row.in_reply_to }] : []),
    ]);

    if (!dryRun) {
      try {
        await stub.createEmail(targetFolder, {
          id: newId,
          subject: row.subject || "",
          sender,
          recipient: recipients.join(", "),
          cc: cc.length ? cc.join(", ") : null,
          bcc: bcc.length ? bcc.join(", ") : null,
          date: row.create_time || new Date().toISOString(),
          body,
          read: row.type === SEND ? true : Number(row.unread) === 1,
          starred: Number(row.is_starred || 0) === 1,
          in_reply_to: row.in_reply_to || null,
          email_references: row.in_reply_to ? JSON.stringify([row.in_reply_to]) : null,
          thread_id: threadId,
          message_id: row.message_id || null,
          raw_headers: rawHeaders,
        }, targetAttachments);
      } catch (error) {
        errors.push(`Email ${row.email_id} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    migrated++;
  }

  const nextCursor = rows.length ? rows[rows.length - 1].email_id : cursor;
  return {
    account: account.email,
    accountId: account.account_id,
    processed: rows.length,
    migrated,
    skipped,
    attachmentCopied,
    attachmentMissing,
    errors: errors.slice(0, 20),
    nextCursor,
    done: rows.length < batch,
  };
}

async function requireToken(request: Request, env: Env) {
  const expected = env.MIGRATION_TOKEN?.trim();
  if (!expected) return json({ error: "MIGRATION_TOKEN is not configured" }, 500);
  const provided = request.headers.get("x-migration-token") || "";
  if (provided !== expected) return json({ error: "Unauthorized" }, 401);
  return null;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cloudmail → Agentic Inbox Migration</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:900px;margin:40px auto;padding:0 20px;line-height:1.5;color:#222}h1{font-size:26px}button{padding:10px 16px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer;margin:6px 6px 6px 0}button:disabled{opacity:.5;cursor:not-allowed}input,select{padding:9px;border:1px solid #bbb;border-radius:7px;margin:5px 0;width:100%;box-sizing:border-box}.card{border:1px solid #ddd;border-radius:12px;padding:18px;margin:16px 0}.muted{color:#666}.progress{white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px;min-height:120px}.danger{color:#a00}</style></head>
<body><h1>Cloudmail → Agentic Inbox</h1>
<p class="muted">One-shot migration is deliberately avoided. The tool moves small batches, can be safely resumed, and never sends an email.</p>
<div class="card"><label>Migration token</label><input id="token" type="password" placeholder="Worker secret MIGRATION_TOKEN">
<label>Mailbox</label><select id="account"><option value="__all__">All mailboxes</option></select>
<label><input id="deleted" type="checkbox" style="width:auto"> Include old records marked deleted → Trash</label>
<label><input id="dry" type="checkbox" style="width:auto"> Dry run (do not write anything)</label>
<br><button id="start">Start / Resume</button><button id="refresh">Refresh mailboxes</button></div>
<div class="card"><h3>Progress</h3><div id="progress" class="progress">Ready.</div></div>
<script>
const $=id=>document.getElementById(id);let accounts=[];let running=false;
function headers(){return {'content-type':'application/json','x-migration-token':$('token').value.trim()}}
async function loadAccounts(){const r=await fetch('/api/accounts',{headers:headers()});if(!r.ok){$('progress').textContent=await r.text();return}accounts=await r.json();$('account').innerHTML='<option value="__all__">All mailboxes</option>'+accounts.map(a=>'<option value="'+a.account_id+'">'+a.email+'</option>').join('');}
function log(x){$('progress').textContent=x}
async function migrateAccount(a){let cursor=0,total=0,skipped=0,att=0,missing=0;while(true){const qs=new URLSearchParams({accountId:String(a.account_id),cursor:String(cursor),batch:'10',includeDeleted:String($('deleted').checked),dryRun:String($('dry').checked)});const r=await fetch('/api/migrate?'+qs,{method:'POST',headers:headers()});const data=await r.json();if(!r.ok)throw new Error(data.error||JSON.stringify(data));total+=data.migrated;skipped+=data.skipped;att+=data.attachmentCopied;missing+=data.attachmentMissing;cursor=data.nextCursor;log('Mailbox: '+a.email+'\\nProcessed: '+data.processed+'\\nMigrated: '+total+'\\nAlready present: '+skipped+'\\nAttachments copied: '+att+'\\nMissing attachments: '+missing+(data.errors?.length?'\\n\\nWarnings:\\n'+data.errors.join('\\n'):'')+'\\n\\n'+(data.done?'Mailbox complete.':'Continuing…'));if(data.done)break;}}
$('refresh').onclick=loadAccounts;$('start').onclick=async()=>{if(running)return;running=true;$('start').disabled=true;try{if(!accounts.length)await loadAccounts();const id=$('account').value;const list=id==='__all__'?accounts:accounts.filter(a=>String(a.account_id)===id);for(const a of list){await migrateAccount(a)}log($('progress').textContent+'\\n\\nALL SELECTED MAILBOXES COMPLETE.');}catch(e){log('STOPPED: '+e.message)}finally{running=false;$('start').disabled=false}};
</script></body></html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname.startsWith("/api/")) {
      const auth = await requireToken(request, env);
      if (auth) return auth;
    }
    if (request.method === "GET" && url.pathname === "/api/accounts") {
      try {
        const accounts = await sourceAccounts(env);
        return json(accounts.map((a) => ({ account_id: a.account_id, email: a.email, name: a.name, user_id: a.user_id })));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/migrate") {
      try {
        const accountId = Number(url.searchParams.get("accountId"));
        const cursor = Math.max(0, Number(url.searchParams.get("cursor") || 0));
        const batch = Math.min(BATCH_MAX, Math.max(1, Number(url.searchParams.get("batch") || BATCH_DEFAULT)));
        const includeDeleted = url.searchParams.get("includeDeleted") === "true";
        const dryRun = url.searchParams.get("dryRun") === "true";
        if (!Number.isInteger(accountId) || accountId <= 0) return json({ error: "Invalid accountId" }, 400);
        const account = (await sourceAccounts(env)).find((a) => a.account_id === accountId);
        if (!account) return json({ error: "Source mailbox not found" }, 404);
        return json(await migrateBatch(env, account, cursor, batch, includeDeleted, dryRun));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
