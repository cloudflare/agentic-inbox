import fs from "node:fs";

// Explicitly scoped to the incident. No messages are deleted or sent.
const apply = process.argv.includes("--apply");
const envPath = process.env.INBOX_ENV_FILE;
if (!envPath) throw new Error("INBOX_ENV_FILE is required");
const env = Object.fromEntries(fs.readFileSync(envPath, "utf8").split("\n").flatMap(line => {
	const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
	if (!match) return [];
	let value = match[2].trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
	return [[match[1], value]];
}));
const base = "https://agentic-inbox.vonzbern.workers.dev";
const headers = {
	"X-API-Key": env.EMAILBOX_API_KEY,
	"CF-Access-Client-Id": env.AGENTIC_INBOX_ACCESS_CLIENT_ID,
	"CF-Access-Client-Secret": env.AGENTIC_INBOX_ACCESS_CLIENT_SECRET,
};
async function request(path, options = {}) {
	const response = await fetch(base + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30000), redirect: "error" });
	if (!response.ok) throw new Error(`Inbox request failed: ${response.status}`);
	return response.json();
}
const pathFor = (mailbox, id) => `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/emails/${encodeURIComponent(id)}`;
const mailboxes = await request("/api/v1/mailboxes");
const records = [];
for (const mailbox of mailboxes) {
	for (let page = 1; ; page++) {
		const rows = await request(`/api/v1/mailboxes/${encodeURIComponent(mailbox.id)}/emails?limit=100&page=${page}&sortColumn=date&sortDirection=ASC`);
		for (const row of rows) {
			if (row.date >= "2026-10-08T08:05:10.059Z" && row.date <= "2026-10-13T06:40:57.727Z") {
				records.push({ mailbox: mailbox.id, email: await request(pathFor(mailbox.id, row.id)) });
			}
		}
		if (rows.length < 100) break;
	}
}
const results = [];
for (const target of records.filter(r => !r.email.attachments.length)) {
	const source = records.find(r => r.mailbox !== target.mailbox && r.email.message_id && r.email.message_id === target.email.message_id && r.email.body === target.email.body && r.email.attachments.length);
	if (!source) continue;
	let restored = 0;
	if (apply) {
		const outcome = await request(pathFor(target.mailbox, target.email.id) + "/restore-attachments", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sourceMailbox: source.mailbox, sourceId: source.email.id }),
		});
		restored = outcome.restored;
		const verified = await request(pathFor(target.mailbox, target.email.id));
		if (verified.attachments.length !== source.email.attachments.length || verified.read !== target.email.read || verified.body !== target.email.body) throw new Error("Repair verification failed");
	}
	results.push({ mailbox: target.mailbox, emailId: target.email.id, sourceMailbox: source.mailbox, attachments: source.email.attachments.length, restored });
}
console.log(JSON.stringify({ apply, mailboxes: mailboxes.length, incidentRecords: records.length, candidates: results.length, attachmentFilesRestored: results.reduce((n, r) => n + r.restored, 0), results }, null, 2));
