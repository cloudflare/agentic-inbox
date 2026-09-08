import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

globalThis.fetch = async () => { throw new Error("Network access is forbidden in agent-access tests"); };
const stubs = {
	"workers-ai-provider": "export const createWorkersAI = ({binding}) => () => ({binding});",
	"ai": "export async function generateText(options) { const ai=options.model.binding; ai.generations.push(options); if(ai.onGenerate) await ai.onGenerate(); return {text:ai.generatedText}; }",
};
const output = await build({ stdin: { contents: `export * from './workers/agent-access/routes.ts'; export * from './workers/agent-access/credentials.ts'; export * from './workers/agent-access/operations.ts'; export * from './shared/agent-access.ts'; export * from './shared/signature.ts';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "esm", banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(process.cwd()+'/package.json');" }, plugins: [{ name: "offline-ai", setup(b) {
	b.onResolve({filter:/^(ai|workers-ai-provider)$/}, args => ({path:args.path,namespace:"offline-ai"}));
	b.onLoad({filter:/.*/,namespace:"offline-ai"}, args => ({contents:stubs[args.path],loader:"js"}));
} }] });
const { handleAgentRequest, agentAdminRoutes, createCredential, credentialKey, executeAgentOperation, defaultAgentConfig, renderFooter } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const mailboxId = "mail@example.com", recipient = "test-recipient@example.com";

function storage() {
	const values = new Map();
	let tail = Promise.resolve();
	return { values,
		get: async key => structuredClone(values.get(key)),
		put: async (key,value) => values.set(key,structuredClone(value)),
		transaction(fn) {
			const task = tail.then(async () => {
				const copy = new Map(structuredClone([...values]));
				const result = await fn({get:async key=>structuredClone(copy.get(key)),put:async(key,value)=>copy.set(key,structuredClone(value))});
				values.clear(); for (const [key,value] of copy) values.set(key,value);
				return result;
			});
			tail = task.catch(()=>{}); return task;
		},
	};
}
async function fixture(overrides = {}) {
	const objects = new Map(); let revision=0;
	const writeObject = (key,value) => { const row={value:structuredClone(value),etag:String(++revision)}; objects.set(key,row); return {etag:row.etag}; };
	const footer = "---\nExample Team\nhttps://example.com";
	writeObject(`mailboxes/${mailboxId}.json`, {fromName:"Example",agentSystemPrompt:"Be concise",signature:{enabled:true,text:footer}});
	writeObject("mailboxes/support@example.com.json", {fromName:"Support"});
	const original={id:"original",subject:"Question",sender:recipient,recipient:mailboxId,body:"<p>Please help with my request.</p>",date:"2026-09-08T10:00:00Z",folder_id:"inbox",thread_id:"thread",message_id:"original-message",read:false,starred:false};
	const emails = new Map([[mailboxId,new Map([[original.id,structuredClone(original)]])],["support@example.com",new Map()]]);
	const states = new Map(); const deliveries=[]; const pending=[];
	const env = {
		BUCKET: {
			get:async key=>{const row=objects.get(key);return row?{etag:row.etag,json:async()=>structuredClone(row.value)}:null;},
			head:async key=>objects.has(key)?{etag:objects.get(key).etag}:null,
			put:async(key,value,options)=>{if(options?.onlyIf?.etagMatches!==undefined && objects.get(key)?.etag!==options.onlyIf.etagMatches)return null;return writeObject(key,JSON.parse(value));},
			list:async({prefix})=>({truncated:false,objects:[...objects].filter(([key])=>key.startsWith(prefix)).map(([key,row])=>({key,etag:row.etag}))}),
		},
		AI: {generations:[],generatedText:"Thank you for your message. We will help you shortly.",run:async(_model,options)=>({response:options.max_tokens===10?"NO":"Thank you for your message. We will help you shortly."})},
		EMAIL: {send:async message=>{assert.equal(message.to,recipient);assert.equal(message.cc,undefined);assert.equal(message.bcc,undefined);deliveries.push(structuredClone(message));return {messageId:"mock-provider-id"};}},
	};
	env.MAILBOX = {idFromName:id=>id,get:id=>{
		if(!emails.has(id))throw new Error("Unexpected mailbox access");
		if(!states.has(id))states.set(id,storage());
		const records=emails.get(id), state=states.get(id);
		return {getEmail:async key=>structuredClone(records.get(key))||null,
			getEmails:async opts=>[...records.values()].filter(e=>!opts?.folder||e.folder_id===opts.folder),
			getThreadEmails:async thread=>[...records.values()].filter(e=>e.thread_id===thread),
			searchEmails:async()=>[...records.values()],
			createEmail:async(folder,email)=>{if(env.failSentStore && folder==="sent")throw new Error("Storage failure");records.set(email.id,{...email,folder_id:folder});},
			checkSendRateLimit:async()=>null,
			executeAgentAction:(id,hash,action,input)=>executeAgentOperation(env,state,id,hash,action,input),
			getAgentActivity:async id=>[...state.values].filter(([key])=>key.startsWith(`agent-activity:${id}:`)).sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value),
		};
	}};
	const {access,token}=await createCredential(env,{...defaultAgentConfig(mailboxId),name:"Offline agent",testRecipient:recipient,...overrides});
	const f={env,access,token,objects,emails,states,deliveries,pending,original,footer,writeObject,ctx:{waitUntil:p=>pending.push(p)}};
	f.call=async(action,args,key=token)=>{
		const response=await handleAgentRequest(new Request(`https://inbox.test/agent/api/${action}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},body:JSON.stringify(args)}),env,f.ctx);
		return {status:response.status,body:await response.json()};
	};
	return f;
}
const message = (id="request_001", enabled=true) => ({mailboxId,requestId:id,to:recipient,subject:"Offline test",bodyHtml:"<p>Agent supplied message.</p>",footer:{enabled}});

test("credentials are hashed, shown once, scoped, and revocable",async()=>{
	const f=await fixture();
	const stored=f.objects.get(credentialKey(f.access.id)).value;
	assert.ok(stored.tokenHash);assert.ok(!JSON.stringify(stored).includes(f.token));
	assert.equal((await f.call("list_mailboxes",{},"invalid")).status,401);
	assert.deepEqual((await f.call("list_mailboxes",{})).body.mailboxIds,[mailboxId]);
	assert.equal((await f.call("get_email",{mailboxId:"support@example.com",emailId:"original"})).status,403);
	f.writeObject(credentialKey(f.access.id),{...stored,enabled:false});
	assert.equal((await f.call("list_mailboxes",{})).status,401);
});
test("permissions are enforced for direct calls, not just tool discovery",async()=>{
	const f=await fixture({permissions:["read"]});
	assert.equal((await f.call("send_email",message())).status,403);
	assert.equal((await f.call("create_draft",message())).status,403);
	assert.equal((await f.call("delete_email",{mailboxId,emailId:"original"})).status,404);
	assert.equal(f.emails.get(mailboxId).size,1);assert.equal(f.deliveries.length,0);
});
test("send requests in draft-only mode never deliver and preserve originals",async()=>{
	const f=await fixture();
	const result=await f.call("send_email",message());
	assert.equal(result.body.status,"draft_saved_not_sent");assert.equal(result.body.sent,false);
	assert.equal(f.deliveries.length,0);assert.deepEqual(f.emails.get(mailboxId).get("original"),f.original);
	assert.equal((result.body.html.match(/data-agentic-signature/g)||[]).length,1);
});
test("direct mode applies explicit footer choices and does not repeat delivery",async()=>{
	const f=await fixture({sendMode:"direct"});
	const first=await f.call("send_email",message("request_direct",false));
	const retry=await f.call("send_email",message("request_direct",false));
	assert.equal(first.body.status,"sent");assert.deepEqual(retry.body,first.body);
	assert.equal(first.body.messageId,"mock-provider-id");
	assert.equal(f.emails.get(mailboxId).get(first.body.emailId).message_id,"mock-provider-id");
	assert.equal(f.deliveries.length,1);assert.ok(!f.deliveries[0].html.includes("data-agentic-signature"));
	assert.equal((await f.call("send_email",{...message("request_direct",false),subject:"Changed"})).status,409);
	assert.equal(f.deliveries.length,1);
});
test("footer choice is required, custom footer is escaped and mailbox settings are unchanged",async()=>{
	const f=await fixture({sendMode:"direct"});
	const input=message();delete input.footer;
	assert.equal((await f.call("send_email",input)).status,400);
	await f.call("send_email",{...message(),bodyHtml:`<p>Hello</p>${renderFooter(f.footer)}`,footer:{enabled:true,text:"Custom & <script>bad</script>\nmmarw.com"}});
	assert.equal((f.deliveries[0].html.match(/data-agentic-signature/g)||[]).length,1);
	assert.ok(f.deliveries[0].html.includes("&lt;script&gt;"));
	assert.match(f.deliveries[0].html,/margin-top:32px/);
	assert.match(f.deliveries[0].html,/font-size:12px/);
	assert.match(f.deliveries[0].html,/href="https:\/\/mmarw\.com"/);
	assert.match(f.deliveries[0].html,/color:#666666;text-decoration:none/);
	assert.equal(f.objects.get(`mailboxes/${mailboxId}.json`).value.signature.text,f.footer);
});
test("test mode and recipient restrictions apply before any AI or send work",async()=>{
	const f=await fixture({sendMode:"direct",allowedRecipients:["allowed@example.com"]});
	const denied=await f.call("send_email",message());
	assert.equal(denied.status,403);assert.equal(f.deliveries.length,0);assert.equal(f.env.AI.generations.length,0);
});
test("inbox AI generates a reviewable draft on demand, with no tools and no send",async()=>{
	const f=await fixture({sendMode:"direct"});
	const input={mailboxId,requestId:"generate_001",originalEmailId:"original",instructions:"Be helpful",footer:{enabled:false}};
	const result=await f.call("generate_reply_draft",input);
	assert.equal(result.body.status,"draft_created");assert.ok(result.body.html.includes("Thank you"));
	assert.ok(!result.body.html.includes("data-agentic-signature"));
	assert.equal(f.env.AI.generations.length,1);assert.equal(f.env.AI.generations[0].tools,undefined);
	assert.match(f.env.AI.generations[0].system,/Be concise/);
	assert.equal(f.deliveries.length,0);
	const retry=await f.call("generate_reply_draft",input);
	assert.equal(retry.body.draftId,result.body.draftId);assert.equal(f.env.AI.generations.length,1);
	assert.deepEqual(f.emails.get(mailboxId).get("original"),f.original);
});
test("generation limits are enforced per agent and mailbox",async()=>{
	const f=await fixture({maxGenerationsPerDay:1});
	const input={mailboxId,requestId:"generate_limit1",originalEmailId:"original",footer:{enabled:true}};
	assert.equal((await f.call("generate_reply_draft",input)).status,200);
	assert.equal((await f.call("generate_reply_draft",{...input,requestId:"generate_limit2"})).status,429);
	assert.equal(f.env.AI.generations.length,1);
});
test("revocation during generation prevents saving or delivery",async()=>{
	const f=await fixture();
	f.env.AI.onGenerate=async()=>{const record=f.objects.get(credentialKey(f.access.id)).value;f.writeObject(credentialKey(f.access.id),{...record,enabled:false});};
	const result=await f.call("generate_reply_draft",{mailboxId,requestId:"generate_revoke",originalEmailId:"original",footer:{enabled:true}});
	assert.equal(result.status,409);assert.equal(f.emails.get(mailboxId).size,1);assert.equal(f.deliveries.length,0);
});
test("send_draft retains the original draft and prevents a second direct submission",async()=>{
	const f=await fixture({sendMode:"direct"});
	const draft={...f.original,id:"saved-draft",folder_id:"draft",recipient,body:`<p>Draft</p>${renderFooter(f.footer)}`};
	f.emails.get(mailboxId).set(draft.id,structuredClone(draft));
	const input={mailboxId,requestId:"submit_draft1",draftId:draft.id,footer:{enabled:false}};
	assert.equal((await f.call("send_draft",input)).body.sent,true);
	assert.deepEqual(f.emails.get(mailboxId).get(draft.id),draft);
	assert.equal((await f.call("send_draft",{...input,requestId:"submit_draft2"})).status,409);
	assert.equal(f.deliveries.length,1);assert.ok(!f.deliveries[0].html.includes("data-agentic-signature"));
});
test("send rate limits reject excess requests without delivery",async()=>{
	const f=await fixture({sendMode:"direct",maxSendsPerDay:1});
	assert.equal((await f.call("send_email",message("limit_send1"))).body.sent,true);
	assert.equal((await f.call("send_email",message("limit_send2"))).status,429);
	assert.equal(f.deliveries.length,1);
});
test("uncertain provider outcomes are not reported as sent or retried",async()=>{
	const f=await fixture({sendMode:"direct"});let attempts=0;
	f.env.EMAIL.send=async()=>{attempts++;throw new Error("Connection lost");};
	const result=await f.call("send_email",message());
	assert.equal(result.body.status,"outcome_unknown");assert.equal(result.body.sent,null);
	await f.call("send_email",message());assert.equal(attempts,1);
});
test("successful delivery followed by storage failure remains marked as accepted",async()=>{
	const f=await fixture({sendMode:"direct"});f.env.failSentStore=true;
	assert.equal((await f.call("send_email",message())).body.status,"sent_unrecorded");
	await f.call("send_email",message());assert.equal(f.deliveries.length,1);
});
test("administrator listings omit hashes and stale updates are rejected",async()=>{
	const f=await fixture();
	const list=await agentAdminRoutes.request("/",{},f.env);
	assert.ok(!(await list.text()).includes("tokenHash"));
	const config={...defaultAgentConfig(mailboxId),name:"Edited"};
	const update=revision=>agentAdminRoutes.request(`/${f.access.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({config,revision})},f.env);
	assert.equal((await update(f.access.revision)).status,200);
	assert.equal((await update(f.access.revision)).status,409);
});
test("MCP uses the same scoped authorization and exposes server-side generation",async()=>{
	const f=await fixture();
	const rpc=body=>handleAgentRequest(new Request("https://inbox.test/agent/mcp",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream",Authorization:`Bearer ${f.token}`},body:JSON.stringify(body)}),f.env,f.ctx);
	const response=await rpc({jsonrpc:"2.0",id:1,method:"tools/list",params:{}});
	assert.equal(response.status,200);
	const names=(await response.json()).result.tools.map(t=>t.name);
	assert.ok(names.includes("generate_reply_draft"));assert.ok(!names.includes("delete_email"));
	const denied=await rpc({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"get_email",arguments:{mailboxId:"support@example.com",emailId:"original"}}});
	assert.equal((await denied.json()).result.isError,true);
	assert.equal(f.deliveries.length,0);
});

test("draft-only permission cannot read an existing email through quoted content",async()=>{
	const f=await fixture({permissions:["draft"]});
	assert.equal((await f.call("create_draft",{...message(),originalEmailId:"original"})).status,400);
	assert.equal((await f.call("generate_reply_draft",{mailboxId,requestId:"no_read_001",originalEmailId:"original",footer:{enabled:false}})).status,403);
	assert.equal((await f.call("get_email",{mailboxId,emailId:"original"})).status,403);
	assert.equal((await f.call("create_draft",message())).body.status,"draft_created");
	assert.equal(f.deliveries.length,0);
});
test("test recipient guard blocks other addresses before generation or delivery",async()=>{
	const f=await fixture({sendMode:"direct",testMode:true});
	assert.equal((await f.call("send_email",{...message(),to:"blocked@example.com"})).status,403);
	f.emails.get(mailboxId).get("original").sender="blocked@example.com";
	assert.equal((await f.call("generate_reply_draft",{mailboxId,requestId:"blocked_gen1",originalEmailId:"original",footer:{enabled:true}})).status,403);
	assert.equal(f.deliveries.length,0);assert.equal(f.env.AI.generations.length,0);
});
test("concurrent duplicate requests reserve only one send",async()=>{
	const f=await fixture({sendMode:"direct"});
	let started,release;
	const entered=new Promise(resolve=>{started=resolve;});
	const gate=new Promise(resolve=>{release=resolve;});
	const send=f.env.EMAIL.send;
	f.env.EMAIL.send=async value=>{started();await gate;return send(value);};
	const first=f.call("send_email",message());
	await entered;
	try { assert.equal((await f.call("send_email",message())).status,409); }
	finally { release(); }
	assert.equal((await first).body.sent,true);
	assert.equal((await f.call("send_email",message())).body.sent,true);
	assert.equal(f.deliveries.length,1);
});
test("safety rejection stores no draft and never sends",async()=>{
	const f=await fixture();
	f.env.AI.run=async()=>({response:"YES"});
	assert.equal((await f.call("generate_reply_draft",{mailboxId,requestId:"unsafe_gen1",originalEmailId:"original",footer:{enabled:true}})).status,422);
	assert.equal(f.emails.get(mailboxId).size,1);assert.equal(f.env.AI.generations.length,0);assert.equal(f.deliveries.length,0);
});
test("revocation works even if an assigned mailbox no longer exists",async()=>{
	const f=await fixture();
	f.objects.delete(`mailboxes/${mailboxId}.json`);
	const response=await agentAdminRoutes.request(`/${f.access.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({config:{...defaultAgentConfig(mailboxId),name:"Revoked",enabled:false},revision:f.access.revision})},f.env);
	assert.equal(response.status,200);
	assert.equal((await f.call("list_mailboxes",{})).status,401);
});
test("all reading tools reject unassigned mailboxes and browser cookies do not authorize agents",async()=>{
	const f=await fixture();
	for(const [action,extra] of [["get_mailbox",{}],["list_emails",{}],["get_thread",{threadId:"thread"}],["search_emails",{query:"Question"}]]) {
		assert.equal((await f.call(action,{mailboxId:"support@example.com",...extra})).status,403);
	}
	const response=await handleAgentRequest(new Request("https://inbox.test/agent/api/list_mailboxes",{method:"POST",headers:{"Content-Type":"application/json",Cookie:"CF_Authorization=human-session"},body:"{}"}),f.env,f.ctx);
	assert.equal(response.status,401);
});
