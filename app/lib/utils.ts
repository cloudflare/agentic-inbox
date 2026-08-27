import DOMPurify from "dompurify";
import { formatQuotedDate } from "shared/dates";
import type { Attachment } from "~/types";
export { formatListDate, formatDetailDate, formatShortDate } from "shared/dates";
export const formatComposeDate=formatQuotedDate;
export function formatBytes(bytes:number,decimals=1){if(bytes===0)return "0 B";const k=1024,dm=decimals<0?0:decimals,sizes=["B","KB","MB","GB"],i=Math.floor(Math.log(bytes)/Math.log(k));return `${Number.parseFloat((bytes/Math.pow(k,i)).toFixed(dm))} ${sizes[i]}`;}
export function splitEmailList(value?:string|null):string[]{return(value||"").split(",").map(e=>e.trim()).filter(Boolean);}
export function toEmailListValue(addresses:string[]):string|string[]|undefined{return addresses.length===0?undefined:addresses.length===1?addresses[0]:addresses;}
export function htmlToPlainText(html:string):string{const sanitized=DOMPurify.sanitize(html);const div=document.createElement("div");div.innerHTML=sanitized.replace(/<style[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<br\s*\/?>/gi,"\n").replace(/<\/p>/gi,"\n\n").replace(/<p[^>]*>/gi,"").replace(/<div[^>]*>/gi,"").replace(/<\/div>/gi,"\n");return(div.textContent||div.innerText||"").trim();}
export function stripHtml(html:string):string{return html.replace(/<[^>]*>/g,"").replace(/\s+/g," ").trim();}
function decodeHtmlEntities(text:string){return text.replace(/&#(\d+);/g,(_m,c)=>String.fromCharCode(Number(c))).replace(/&#x([0-9a-f]+);/gi,(_m,h)=>String.fromCharCode(Number.parseInt(h,16))).replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'").replace(/&nbsp;/g," ");}
export function getSnippetText(snippet?:string|null,maxLength=100){if(!snippet)return "";const clean=decodeHtmlEntities(snippet.replace(/<style[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<style[^>]*>[\s\S]*/gi,"").replace(/<[^>]*>/g," ").replace(/<[^>]*$/g,"")).replace(/\s+/g," ").trim();return clean?clean.length>maxLength?`${clean.slice(0,maxLength)}...`:clean:"";}
export function escapeHtml(text:string){return text?text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"):"";}
export function getSignatureBlock(settings?:{signature?:{enabled:boolean;text?:string;html?:string;logoDataUrl?:string;logoKey?:string}},mailboxId?:string):string{const sig=settings?.signature;if(!sig?.enabled)return "";const content=sig.html?DOMPurify.sanitize(sig.html):escapeHtml(sig.text||"");let logo="";if(sig.logoKey&&mailboxId){const url=`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/signature-logo`;logo=`<div style="margin-top:10px;"><img src="${url}" alt="Company logo" style="max-height:80px;max-width:280px;display:block;" /></div>`;}else if(sig.logoDataUrl?.startsWith("data:image/")){logo=`<div style="margin-top:10px;"><img src="${sig.logoDataUrl}" alt="Company logo" style="max-height:80px;max-width:280px;display:block;" /></div>`;}return `<div style="border-top:1px solid #ccc;margin-top:16px;padding-top:12px;">${content}${logo}</div>`;}
export function buildQuotedReplyBlock(dateStr:string|undefined,sender:string,body:string){
	if(!body)return "";

	const plainBody = htmlToPlainText(body);

	return `<br><blockquote style="border-left:2px solid #ccc;margin:0;padding-left:1em;color:#666;">On ${formatComposeDate(dateStr)}, ${escapeHtml(sender)} wrote:<br><br>${escapeHtml(plainBody).replace(/\n/g,"<br>")}</blockquote>`;
}
export function rewriteInlineImages(body:string,mailboxId:string,emailId:string,attachments?:{id:string;content_id?:string|null;disposition?:string|null}[]){if(!body||!attachments?.length)return body;let result=body;for(const att of attachments){if(!att.content_id)continue;const cid=att.content_id.replace(/^<|>$/g,"").trim();if(!cid)continue;const relativeUrl=`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(att.id)}`;const url=typeof window!=="undefined"?new URL(relativeUrl,window.location.origin).href:relativeUrl;const escapedCid=cid.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");result=result.replace(new RegExp(`cid:\\s*<?${escapedCid}>?`,"gi"),url);}return result;}
export function getNonInlineAttachments(attachments?:Attachment[]):Attachment[]{return attachments?.filter(a=>a.disposition!=="inline")??[];}
export function getAttachmentUrl(mailboxId:string,emailId:string,attachmentId:string){return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`;}
export function downloadFile(url:string,filename:string){const link=document.createElement("a");link.href=url;link.download=filename;link.target="_blank";link.rel="noopener noreferrer";document.body.appendChild(link);link.click();document.body.removeChild(link);}
