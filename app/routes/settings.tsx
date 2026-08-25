// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file and at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon, PaperPlaneTiltIcon, TelegramLogoIcon, ImageIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";

const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;
const DEFAULT_SIGNATURE = "<div><strong>Gavin Gwynn</strong><br>International Business<br>Astra Trade HK</div>";

function isSafeImageDataUrl(value: string) {
 return /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value.trim());
}

export default function SettingsRoute() {
 const {mailboxId}=useParams<{mailboxId:string}>();
 const toastManager=useKumoToastManager();
 const {data:mailbox}=useMailbox(mailboxId);
 const updateMailboxMutation=useUpdateMailbox();
 const [displayName,setDisplayName]=useState("");
 const [agentPrompt,setAgentPrompt]=useState("");
 const [forwardEnabled,setForwardEnabled]=useState(false);
 const [forwardEmail,setForwardEmail]=useState("");
 const [forwardInternal,setForwardInternal]=useState(true);
 const [telegramEnabled,setTelegramEnabled]=useState(false);
 const [telegramToken,setTelegramToken]=useState("");
 const [telegramChatId,setTelegramChatId]=useState("");
 const [telegramInternal,setTelegramInternal]=useState(true);
 const [signatureEnabled,setSignatureEnabled]=useState(false);
 const [signatureHtml,setSignatureHtml]=useState("");
 const [signatureLogo,setSignatureLogo]=useState("");
 const [logoPreview,setLogoPreview]=useState("");
 const [isSaving,setIsSaving]=useState(false);
 useEffect(()=>{
  if(!mailbox)return;
  const s=mailbox.settings||{};
  setDisplayName(s.fromName||mailbox.name||"");
  setAgentPrompt(s.agentSystemPrompt||"");
  setForwardEnabled(s.forwarding?.enabled===true);
  setForwardEmail(s.forwarding?.email||"");
  setForwardInternal(s.forwarding?.includeInternal!==false);
  setTelegramEnabled(s.telegram?.enabled===true);
  setTelegramToken(s.telegram?.botToken||"");
  setTelegramChatId(s.telegram?.chatId||"");
  setTelegramInternal(s.telegram?.includeInternal!==false);
  setSignatureEnabled(s.signature?.enabled===true);
  setSignatureHtml(s.signature?.html||s.signature?.text||"");
  const stored=s.signature?.logoDataUrl||"";
  const valid=isSafeImageDataUrl(stored);
  setSignatureLogo(valid?stored:"");
  setLogoPreview(valid?stored:"");
 },[mailbox]);
 const handleLogo=(e:React.ChangeEvent<HTMLInputElement>)=>{
  const file=e.target.files?.[0];
  if(!file)return;
  if(!["image/png","image/jpeg","image/gif","image/webp"].includes(file.type)){toastManager.add({title:"Please select a PNG, JPEG, GIF or WebP image",variant:"error"});return;}
  if(file.size>500*1024){toastManager.add({title:"Logo must be smaller than 500 KB",variant:"error"});return;}
  const reader=new FileReader();
  reader.onload=()=>{const value=String(reader.result||"");if(!isSafeImageDataUrl(value)){toastManager.add({title:"Could not read this image",variant:"error"});return;}setSignatureLogo(value);setLogoPreview(value);};
  reader.onerror=()=>toastManager.add({title:"Could not read this image",variant:"error"});
  reader.readAsDataURL(file);
  e.currentTarget.value="";
 };
 const handleSave=async()=>{
  if(!mailbox||!mailboxId)return;
  if(forwardEnabled&&!forwardEmail.trim()){toastManager.add({title:"Enter a forwarding email address",variant:"error"});return;}
  if(telegramEnabled&&(!telegramToken.trim()||!telegramChatId.trim())){toastManager.add({title:"Enter the Telegram Bot Token and Chat ID",variant:"error"});return;}
  setIsSaving(true);
  const settings={...mailbox.settings,fromName:displayName,agentSystemPrompt:agentPrompt.trim()||undefined,forwarding:{...mailbox.settings?.forwarding,enabled:forwardEnabled,email:forwardEmail.trim().toLowerCase(),includeInternal:forwardInternal},telegram:{...mailbox.settings?.telegram,enabled:telegramEnabled,botToken:telegramToken.trim(),chatId:telegramChatId.trim(),includeInternal:telegramInternal},signature:{...mailbox.settings?.signature,enabled:signatureEnabled,html:signatureHtml.trim()||DEFAULT_SIGNATURE,logoDataUrl:isSafeImageDataUrl(signatureLogo)?signatureLogo:undefined}};
  try{await updateMailboxMutation.mutateAsync({mailboxId,settings});toastManager.add({title:"Settings saved!"});}catch{toastManager.add({title:"Failed to save settings",variant:"error"});}finally{setIsSaving(false);}
 };
 if(!mailbox)return <div className="flex justify-center py-20"><Loader size="lg"/></div>;
 const isCustomPrompt=agentPrompt.trim().length>0;
 return <div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto"><h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1><div className="space-y-6">
  <div className="rounded-lg border border-kumo-line bg-kumo-base p-5"><div className="text-sm font-medium text-kumo-default mb-4">Account</div><div className="space-y-3"><Input label="Display Name" value={displayName} onChange={e=>setDisplayName(e.target.value)}/><Input label="Email" type="email" value={mailbox.email} disabled/></div></div>
  <div className="rounded-lg border border-kumo-line bg-kumo-base p-5"><div className="flex items-center justify-between mb-4"><div className="flex items-center gap-2"><RobotIcon size={16} weight="duotone" className="text-kumo-subtle"/><span className="text-sm font-medium">AI Agent Prompt</span>{isCustomPrompt?<Badge variant="primary">Custom</Badge>:<Badge variant="secondary">Default</Badge>}</div>{isCustomPrompt&&<Button variant="ghost" size="xs" icon={<ArrowCounterClockwiseIcon size={14}/>} onClick={()=>setAgentPrompt("")}>Reset to default</Button>}</div><p className="text-xs text-kumo-subtle mb-3">Customize how the AI agent behaves for this mailbox.</p><textarea value={agentPrompt} onChange={e=>setAgentPrompt(e.target.value)} placeholder={PROMPT_PLACEHOLDER} rows={10} className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs font-mono leading-relaxed"/></div>
  <div className="rounded-lg border border-kumo-line bg-kumo-base p-5"><div className="text-sm font-medium mb-3">Email Signature</div><p className="text-xs text-kumo-subtle mb-4">The signature is inserted automatically into new messages, replies and forwards. The logo is sent as an inline CID image, not a normal attachment.</p><label className="flex items-center gap-2 text-sm mb-4"><input type="checkbox" checked={signatureEnabled} onChange={e=>setSignatureEnabled(e.target.checked)}/> Enable signature</label><textarea value={signatureHtml} onChange={e=>setSignatureHtml(e.target.value)} rows={7} disabled={!signatureEnabled} placeholder={DEFAULT_SIGNATURE} className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm font-mono"/><div className="mt-4 flex items-center gap-4"><label className="inline-flex items-center gap-2 cursor-pointer text-sm rounded-md border border-kumo-line px-3 py-2 hover:bg-kumo-tint"><ImageIcon size={16}/> Upload company logo<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={handleLogo} disabled={!signatureEnabled}/></label>{logoPreview&&<div className="flex items-center gap-3"><div className="w-48 h-20 flex items-center justify-center overflow-hidden border border-kumo-line rounded p-1 bg-white"><img src={logoPreview} alt="Signature logo preview" className="max-h-full max-w-full object-contain" onError={()=>{setLogoPreview("");setSignatureLogo("");}}/></div><Button size="xs" variant="ghost" onClick={()=>{setSignatureLogo("");setLogoPreview("");}}>Remove</Button></div>}</div><p className="text-xs text-kumo-subtle mt-3">Logo limit: 500 KB. The settings preview uses the original image data; only when sending is it converted to an inline Content-ID resource.</p></div>
  <div className="rounded-lg border border-kumo-line bg-kumo-base p-5"><div className="flex items-center gap-2 mb-2"><PaperPlaneTiltIcon size={17}/><div className="text-sm font-medium">Third-party email forwarding</div></div><p className="text-xs text-kumo-subtle mb-4">Forward newly delivered messages to another email address.</p><label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={forwardEnabled} onChange={e=>setForwardEnabled(e.target.checked)}/> Enable forwarding</label><Input label="Forward to" type="email" value={forwardEmail} onChange={e=>setForwardEmail(e.target.value)} disabled={!forwardEnabled} placeholder="backup@example.com"/><label className="flex items-center gap-2 text-xs text-kumo-subtle mt-3"><input type="checkbox" checked={forwardInternal} onChange={e=>setForwardInternal(e.target.checked)} disabled={!forwardEnabled}/> Also forward internal mail</label></div>
  <div className="rounded-lg border border-kumo-line bg-kumo-base p-5"><div className="flex items-center gap-2 mb-2"><TelegramLogoIcon size={17}/><div className="text-sm font-medium">Telegram notifications</div></div><p className="text-xs text-kumo-subtle mb-4">Send a compact notification to a Telegram bot when a message arrives.</p><label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={telegramEnabled} onChange={e=>setTelegramEnabled(e.target.checked)}/> Enable Telegram notifications</label><div className="space-y-3"><Input label="Bot Token" type="password" value={telegramToken} onChange={e=>setTelegramToken(e.target.value)} disabled={!telegramEnabled}/><Input label="Chat ID" value={telegramChatId} onChange={e=>setTelegramChatId(e.target.value)} disabled={!telegramEnabled}/></div><label className="flex items-center gap-2 text-xs text-kumo-subtle mt-3"><input type="checkbox" checked={telegramInternal} onChange={e=>setTelegramInternal(e.target.checked)} disabled={!telegramEnabled}/> Also notify for internal mail</label></div>
  <div className="flex justify-end"><Button variant="primary" onClick={handleSave} loading={isSaving}>Save Changes</Button></div>
 </div></div>;
}
