// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:workers";
export interface SendEmailParams { to:string|string[]; from:string|{email:string;name:string}; subject:string; html?:string; text?:string; cc?:string|string[]; bcc?:string|string[]; replyTo?:string|{email:string;name:string}; attachments?:{content:string;filename:string;type:string;disposition:"attachment"|"inline";contentId?:string}[]; headers?:Record<string,string>; }
function formatAddress(address:string|{email:string;name:string}){return typeof address==="string"?address:`${address.name} <${address.email}>`;}
export async function sendEmail(_binding:SendEmail,params:SendEmailParams):Promise<{messageId:string}>{
 const apiKey=(env as unknown as {RESEND_API_KEY?:string}).RESEND_API_KEY;if(!apiKey)throw new Error("RESEND_API_KEY is not configured");
 const payload:Record<string,unknown>={to:params.to,from:formatAddress(params.from),subject:params.subject};if(params.html!==undefined)payload.html=params.html;if(params.text!==undefined)payload.text=params.text;if(params.cc)payload.cc=params.cc;if(params.bcc)payload.bcc=params.bcc;if(params.replyTo)payload.reply_to=formatAddress(params.replyTo);if(params.headers&&Object.keys(params.headers).length)payload.headers=params.headers;
 if(params.attachments?.length)payload.attachments=params.attachments.map(att=>({content:att.content,filename:att.filename,content_type:att.type,content_id:att.contentId,...(att.disposition==="inline"?{content_disposition:"inline"}:{})}));
 const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json","User-Agent":"agentic-inbox/1.0"},body:JSON.stringify(payload)});const result=await response.json().catch(()=>({})) as {id?:string;message?:string};if(!response.ok)throw new Error(result.message||`Resend API request failed: ${response.status}`);if(!result.id)throw new Error("Resend API returned no message ID");return{messageId:result.id};
}
