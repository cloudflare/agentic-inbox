import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// Test route authorization with explicit JWT-verifier doubles, not cryptography.
globalThis.fetch = async () => { throw new Error("Network forbidden"); };
const modules = {
	agents: "export const routeAgentRequest=async()=>new Response('legacy agent');",
	jose: "export const createRemoteJWKSet=()=>({}); export const jwtVerify=async token=>({payload:JSON.parse(token)});",
	"react-router": "export const createRequestHandler=()=>()=>new Response('dashboard');",
	"virtual:react-router/server-build": "export default {};",
	"./index": "import {Hono} from 'hono'; export const app=new Hono(); app.get('/api/v1/legacy',c=>c.text('legacy')); export const receiveEmail=async()=>{};",
	"./mcp": "export class EmailMCP {static serve(){return {fetch:()=>new Response('legacy mcp')};}}",
	"./durableObject": "export class MailboxDO {}",
	"./agent": "export class EmailAgent {}",
};
const bundle = await build({entryPoints:["workers/app.ts"],bundle:true,write:false,platform:"node",format:"esm",define:{"import.meta.env.DEV":"false","import.meta.env.MODE":"\"production\""},banner:{js:"import {createRequire} from 'node:module';const require=createRequire(process.cwd()+'/package.json');"},plugins:[{name:"auth-double",setup(b){
	b.onResolve({filter:/.*/},args=>{
		if(Object.hasOwn(modules,args.path) && (args.importer.endsWith("/workers/app.ts") || args.path==="jose"))return {path:args.path,namespace:"auth-double"};
	});
	b.onLoad({filter:/.*/,namespace:"auth-double"},args=>({contents:modules[args.path],loader:"js",resolveDir:process.cwd()}));
}}]});
const {default:worker}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const env={POLICY_AUD:"aud",TEAM_DOMAIN:"https://team.cloudflareaccess.com",BUCKET:{list:async()=>({objects:[],truncated:false})}};
const ctx={waitUntil:()=>{}};
const request=(path,headers={},bindings=env)=>worker.fetch(new Request(`https://inbox.test${path}`,{headers}),bindings,ctx);
const human={"cf-access-jwt-assertion":JSON.stringify({email:"operator@example.com"})};

test("production fails closed without Access configuration or valid assertion",async()=>{
	assert.equal((await request("/api/v1/legacy",{},{})).status,500);
	assert.equal((await request("/api/v1/legacy")).status,403);
	assert.equal((await request("/api/v1/legacy",{"cf-access-jwt-assertion":"invalid"})).status,403);
});
test("human login retains administration while service principals cannot administer",async()=>{
	assert.equal((await request("/api/v1/agent-access",human)).status,200);
	assert.equal((await request("/api/v1/agent-access",{"cf-access-jwt-assertion":JSON.stringify({common_name:"service-token"})})).status,403);
	assert.equal((await request("/mcp",{"cf-access-jwt-assertion":JSON.stringify({})})).status,403);
});
test("scoped keys cannot fall through to legacy routes even alongside human login",async()=>{
	for(const path of ["/api/v1/agent-access","/api/v1/legacy","/mcp","/agents/email-agent/mail"]) {
		assert.equal((await request(path,{...human,Authorization:"Bearer mai_invalid"})).status,403);
	}
});
test("dedicated namespace requires a scoped key independently of human Access",async()=>{
	for(const path of ["/agent/mcp","/agent/api/list_mailboxes","/agent/unknown"]) {
		assert.equal((await request(path,human)).status,401);
		assert.equal((await request(path)).status,401);
	}
});
