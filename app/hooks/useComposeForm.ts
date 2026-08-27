import { useKumoToastManager } from "@cloudflare/kumo";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { buildQuotedReplyBlock, escapeHtml, formatComposeDate, getSignatureBlock, htmlToPlainText, splitEmailList, stripHtml, toEmailListValue } from "~/lib/utils";
import { useDeleteEmail, useForwardEmail, useReplyToEmail, useSaveDraft, useSendEmail } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
function normalizeEmailAddress(value:string){
	const match=value.match(/<([^>]+)>/);
	return (match?.[1] || value).trim().toLowerCase();
}

function appendUniqueAddress(
	addresses:string[],
	seen:Set<string>,
	address:string,
	exclude?:string
){
	const t=address.trim();
	if(!t)return;

	const n=normalizeEmailAddress(t);

	if(n===exclude || seen.has(n))return;

	seen.add(n);
	addresses.push(t);
}
interface ComposeFormFields{to:string;cc:string;bcc:string;showCcBcc:boolean;subject:string;body:string;}
interface ComposeAttachment{content:string;filename:string;type:string;disposition:"attachment";size:number;}
const EMPTY_FIELDS:ComposeFormFields={to:"",cc:"",bcc:"",showCcBcc:false,subject:"",body:""};const MAX_ATTACHMENT_SIZE=20*1024*1024;const MAX_TOTAL_ATTACHMENT_SIZE=24*1024*1024;
function getPrefixedSubject(subject:string,prefix:"Re"|"Fwd"){const p=`${prefix}: `;return subject.startsWith(p)?subject:`${p}${subject}`;}
function buildForwardBody(original:NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,sigBlock:string){return `<p><br></p>${sigBlock?`${sigBlock}<br>`:""}<div style="border:1px solid #ddd;padding:1em;background-color:#f9f9f9;margin:1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${escapeHtml(original.sender)}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${escapeHtml(original.subject)}<br><br>${escapeHtml(stripHtml(original.body||"")).replace(/\n/g,"<br>")}</div>`;}
function buildReplyAllFields(
	original:NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddress?:string
){
	const normalizedSelf=selfAddress
		? normalizeEmailAddress(selfAddress)
		: undefined;

	const to:string[]=[];
	const seen=new Set<string>();

	appendUniqueAddress(
		to,
		seen,
		original.sender,
		normalizedSelf
	);

	for(const r of splitEmailList(original.recipient)){
		appendUniqueAddress(
			to,
			seen,
			r,
			normalizedSelf
		);
	}

	const cc:string[]=[];
	const ccSeen=new Set<string>();

	for(const r of splitEmailList(original.cc)){
		const n=normalizeEmailAddress(r);

		if(
			n===normalizedSelf ||
			seen.has(n) ||
			ccSeen.has(n)
		){
			continue;
		}

		ccSeen.add(n);
		cc.push(r);
	}

	return {
		to:to.join(", "),
		cc:cc.join(", "),
		showCcBcc:cc.length>0
	};
}
function buildInitialComposeFields(options:ReturnType<typeof useUIStore.getState>["composeOptions"],mailboxEmail:string|undefined,sigBlock:string):ComposeFormFields{const{draftEmail:draft,originalEmail:original,mode}=options;if(draft)return{to:draft.recipient||"",cc:draft.cc||"",bcc:draft.bcc||"",showCcBcc:Boolean(draft.cc||draft.bcc),subject:draft.subject||"",body:draft.body||""};if(!original)return{...EMPTY_FIELDS,body:sigBlock?`<p><br></p>${sigBlock}`:""};if(mode==="reply")return{...EMPTY_FIELDS,to:original.sender,subject:getPrefixedSubject(original.subject,"Re"),body:`<p><br></p>${sigBlock?`${sigBlock}<br>`:""}${buildQuotedReplyBlock(original.date,original.sender,original.body||"")}`};if(mode==="reply-all"){const r=buildReplyAllFields(
	original,
	mailboxEmail
);return{...EMPTY_FIELDS,...r,subject:getPrefixedSubject(original.subject,"Re"),body:`<p><br></p>${sigBlock?`${sigBlock}<br>`:""}${buildQuotedReplyBlock(original.date,original.sender,original.body||"")}`};}if(mode==="forward")return{...EMPTY_FIELDS,subject:getPrefixedSubject(original.subject,"Fwd"),body:buildForwardBody(original,sigBlock)};return{...EMPTY_FIELDS,body:sigBlock?`<p><br></p>${sigBlock}`:""};}
async function fileToBase64(file:File){const bytes=new Uint8Array(await file.arrayBuffer());let binary="";for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode.apply(null,Array.from(bytes.subarray(i,i+0x8000)));return btoa(binary);}
async function fetchLogoAttachment(mailboxId:string,logoKey?:string){if(!logoKey)return null;const res=await fetch(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/signature-logo`,{cache:"no-store"});if(!res.ok)return null;const type=res.headers.get("content-type")||"image/png";const blob=await res.blob();return{content:await fileToBase64(new File([blob],"company-logo",{type})),filename:`company-logo.${type.split("/")[1]||"png"}`,type,disposition:"inline" as const,contentId:"company-signature-logo"};}
function convertSignatureToCid(html:string){return html.replace(/src=["'][^"']*\/api\/v1\/mailboxes\/[^"']*\/signature-logo[^"']*["']/gi,'src="cid:company-signature-logo"').replace(/src=["'](data:image\/[a-z0-9.+-]+;base64,[^"']+)["']/gi,'src="cid:company-signature-logo"');}
export function useComposeForm(mailboxId?:string,_folder?:string){const toastManager=useKumoToastManager();const{composeOptions,closePanel,closeCompose}=useUIStore();const{data:currentMailbox}=useMailbox(mailboxId);const sendEmailMutation=useSendEmail();const saveDraftMutation=useSaveDraft();const replyMutation=useReplyToEmail();const forwardMutation=useForwardEmail();const deleteEmailMutation=useDeleteEmail();const[to,setTo]=useState("");const[cc,setCc]=useState("");const[bcc,setBcc]=useState("");const[showCcBcc,setShowCcBcc]=useState(false);const[subject,setSubject]=useState("");const[body,setBody]=useState("");const[attachments,setAttachments]=useState<ComposeAttachment[]>([]);const[error,setError]=useState<string|null>(null);const[isSavingDraft,setIsSavingDraft]=useState(false);const[isSending,setIsSending]=useState(false);const lastInitializedOptionsRef=useRef<typeof composeOptions|null>(null);const isDraftEdit=!!composeOptions.draftEmail;const formTitle=useMemo(()=>isDraftEdit?"Edit Draft":composeOptions.mode==="reply"?"Reply":composeOptions.mode==="reply-all"?"Reply All":composeOptions.mode==="forward"?"Forward":"New Message",[composeOptions.mode,isDraftEdit]);const sigBlock=useMemo(()=>getSignatureBlock(currentMailbox?.settings,mailboxId),[currentMailbox,mailboxId]);
useEffect(()=>{if(lastInitializedOptionsRef.current===composeOptions)return;lastInitializedOptionsRef.current=composeOptions;const f=buildInitialComposeFields(composeOptions,currentMailbox?.email,sigBlock);setError(null);setTo(f.to);setCc(f.cc);setBcc(f.bcc);setShowCcBcc(f.showCcBcc);setSubject(f.subject);setBody(f.body);setAttachments([]);},[composeOptions,currentMailbox?.email,sigBlock]);
const addAttachments=async(files:FileList|null)=>{if(!files?.length)return;try{let total=attachments.reduce((s,a)=>s+a.size,0);const next:ComposeAttachment[]=[];for(const file of Array.from(files)){if(file.size>MAX_ATTACHMENT_SIZE){toastManager.add({title:`File too large: ${file.name} exceeds 20MB limit`,variant:"error"});continue;}total+=file.size;if(total>MAX_TOTAL_ATTACHMENT_SIZE){toastManager.add({title:"Total attachment size exceeds 24MB limit",variant:"error"});break;}next.push({content:await fileToBase64(file),filename:file.name,type:file.type||"application/octet-stream",disposition:"attachment",size:file.size});}if(next.length)setAttachments(c=>[...c,...next]);}catch(err:unknown){const msg=err instanceof Error?err.message:"Failed to read files";setError(msg);toastManager.add({title:msg,variant:"error"});}};
const removeAttachment=(index:number)=>setAttachments(c=>c.filter((_,i)=>i!==index));
const handleSaveDraft=async()=>{if(!mailboxId||isSending)return;setIsSavingDraft(true);setError(null);try{await saveDraftMutation.mutateAsync({mailboxId,draft:{to,cc:cc||undefined,bcc:bcc||undefined,subject,body,in_reply_to:composeOptions.originalEmail?.id||composeOptions.draftEmail?.in_reply_to||undefined,thread_id:composeOptions.originalEmail?.thread_id||composeOptions.draftEmail?.thread_id||undefined,draft_id:composeOptions.draftEmail?.id||undefined}});toastManager.add({title:"Draft saved!"});}catch(err:unknown){const message=err instanceof Error?err.message:"Failed to save draft.";setError(message);toastManager.add({title:message,variant:"error"});}finally{setIsSavingDraft(false);}};
const handleSend=async(e:FormEvent,onClose:()=>void)=>{e.preventDefault();if(isSending)return;setError(null);if(!currentMailbox||!mailboxId){setError("No mailbox selected.");return;}const toRecipients=splitEmailList(to);if(!toRecipients.length){setError("Add at least one recipient.");return;}const ccRecipients=splitEmailList(cc),bccRecipients=splitEmailList(bcc);const fromName=currentMailbox.settings?.fromName||currentMailbox.name;const from=fromName&&fromName!==currentMailbox.email?{email:currentMailbox.email,name:fromName}:currentMailbox.email;setIsSending(true);toastManager.add({title:"Sending email..."});try{const inlineLogo=currentMailbox.settings?.signature?.enabled?await fetchLogoAttachment(mailboxId,currentMailbox.settings.signature.logoKey):null;const emailData={to:toEmailListValue(toRecipients),cc:toEmailListValue(ccRecipients),bcc:toEmailListValue(bccRecipients),from,subject,html:convertSignatureToCid(body),text:htmlToPlainText(body),attachments:[...attachments,...(inlineLogo?[inlineLogo]:[])].length?[...attachments,...(inlineLogo?[inlineLogo]:[])]:undefined};const draftId=composeOptions.draftEmail?.id,mode=composeOptions.mode,originalId=composeOptions.originalEmail?.id||composeOptions.draftEmail?.in_reply_to;if((mode==="reply"||mode==="reply-all")&&originalId)await replyMutation.mutateAsync({mailboxId,emailId:originalId,email:emailData});else if(mode==="forward"&&originalId)await forwardMutation.mutateAsync({mailboxId,emailId:originalId,email:emailData});else await sendEmailMutation.mutateAsync({mailboxId,email:emailData});if(draftId)deleteEmailMutation.mutate({mailboxId,id:draftId});toastManager.add({title:"Email sent!"});onClose();}catch(err:unknown){const message=err instanceof Error?err.message:"Failed to send email.";setError(message);toastManager.add({title:message,variant:"error"});}finally{setIsSending(false);}};
return{to,setTo,cc,setCc,bcc,setBcc,showCcBcc,setShowCcBcc,subject,setSubject,body,setBody,attachments,addAttachments,removeAttachment,error,setError,isSavingDraft,isSending,formTitle,handleSaveDraft,handleSend,closeCompose,closePanel};}
