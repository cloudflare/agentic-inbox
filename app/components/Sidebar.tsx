// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, Input, Tooltip } from "@cloudflare/kumo";
import { AddressBookIcon, ArchiveIcon, CaretLeftIcon, FileIcon, FolderIcon, PaperPlaneTiltIcon, PencilSimpleIcon, PlusIcon, TrashIcon, TrayIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import { useCreateFolder, useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";

const FOLDER_ICONS: Record<string, React.ReactNode> = { [Folders.INBOX]: <TrayIcon size={18}/>, [Folders.SENT]: <PaperPlaneTiltIcon size={18}/>, [Folders.DRAFT]: <FileIcon size={18}/>, [Folders.ARCHIVE]: <ArchiveIcon size={18}/>, [Folders.TRASH]: <TrashIcon size={18}/> };
const SYSTEM_FOLDER_LINKS = [{ id: Folders.INBOX, label: "Inbox" }, { id: Folders.SENT, label: "Sent" }, { id: Folders.DRAFT, label: "Drafts" }, { id: Folders.ARCHIVE, label: "Archive" }, { id: Folders.TRASH, label: "Trash" }];
interface FolderLinkProps { to:string; icon:React.ReactNode; label:string; unreadCount?:number; onClick?:()=>void; }
function FolderLink({to,icon,label,unreadCount,onClick}:FolderLinkProps){ return <NavLink to={to} onClick={onClick} className={({isActive})=>`flex items-center gap-3 py-2 px-3 rounded-md text-sm transition-colors ${isActive?"bg-kumo-fill font-semibold text-kumo-default":"text-kumo-strong hover:bg-kumo-tint"}`}><span>{icon}</span><span className="truncate flex-1">{label}</span>{unreadCount!=null&&unreadCount>0&&<Badge variant="secondary">{unreadCount}</Badge>}</NavLink>; }

export default function Sidebar(){
 const {mailboxId}=useParams<{mailboxId:string}>(); const navigate=useNavigate(); const {data:folders=[]}=useFolders(mailboxId); const createFolderMutation=useCreateFolder(); const {startCompose,closeSidebar}=useUIStore(); const {data:currentMailbox}=useMailbox(mailboxId); const [isCreateFolderOpen,setIsCreateFolderOpen]=useState(false); const [newFolderName,setNewFolderName]=useState("");
 const customFolders=useMemo(()=>folders.filter(f=>!(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id)),[folders]); const getUnreadCount=(id:string)=>folders.find(f=>f.id===id)?.unreadCount||0;
 const handleCreateFolder=(e:React.FormEvent)=>{e.preventDefault();if(newFolderName.trim()&&mailboxId){createFolderMutation.mutate({mailboxId,name:newFolderName.trim()});setNewFolderName("");setIsCreateFolderOpen(false);}};
 const displayName=useMemo(()=>{if(!currentMailbox)return mailboxId?.split("@")[0]||"Mailbox";return currentMailbox.settings?.fromName||currentMailbox.name||currentMailbox.email.split("@")[0];},[currentMailbox,mailboxId]);
 return <aside className="h-full w-64 bg-kumo-recessed flex flex-col shrink-0 border-r border-kumo-line"><div className="px-4 pt-4 pb-1"><button type="button" onClick={()=>{navigate("/");closeSidebar();}} className="flex items-center gap-1.5 text-kumo-subtle text-sm hover:text-kumo-default mb-2.5"><CaretLeftIcon size={14}/><span>Mailboxes</span></button><div className="px-1"><div className="text-base font-semibold text-kumo-default truncate">{displayName}</div><div className="text-sm text-kumo-subtle truncate mt-0.5">{currentMailbox?.email||mailboxId}</div></div></div>
 <div className="px-3 py-3"><Button variant="primary" icon={<PencilSimpleIcon size={16}/>} onClick={()=>startCompose()} className="w-full">Compose</Button></div>
 <nav className="flex-1 overflow-y-auto px-2 space-y-0.5">{SYSTEM_FOLDER_LINKS.map(f=><FolderLink key={f.id} to={`/mailbox/${mailboxId}/emails/${f.id}`} icon={FOLDER_ICONS[f.id]} label={f.label} unreadCount={getUnreadCount(f.id)} onClick={closeSidebar}/>)}
  <div className="pt-5"><NavLink to={`/mailbox/${mailboxId}/contacts`} onClick={closeSidebar} className={({isActive})=>`flex items-center gap-3 py-2 px-3 rounded-md text-sm ${isActive?"bg-kumo-fill font-semibold text-kumo-default":"text-kumo-strong hover:bg-kumo-tint"}`}><AddressBookIcon size={18}/><span>Contacts</span></NavLink></div>
  <div className="pt-5"><div className="flex items-center justify-between px-3 mb-1.5"><span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">Folders</span><Tooltip content="New folder" asChild><Button variant="ghost" shape="square" size="sm" icon={<PlusIcon size={16}/>} onClick={()=>setIsCreateFolderOpen(true)} aria-label="Create new folder"/></Tooltip></div>{customFolders.map(f=><FolderLink key={f.id} to={`/mailbox/${mailboxId}/emails/${f.id}`} icon={<FolderIcon size={18}/>} label={f.name} unreadCount={f.unreadCount} onClick={closeSidebar}/>)}</div>
 </nav>
 <Dialog.Root open={isCreateFolderOpen} onOpenChange={setIsCreateFolderOpen}><Dialog size="sm" className="p-6"><Dialog.Title className="text-base font-semibold mb-4">Create folder</Dialog.Title><form onSubmit={handleCreateFolder} className="space-y-4"><Input label="Folder name" placeholder="e.g. Projects" value={newFolderName} onChange={e=>setNewFolderName(e.target.value)} required/><div className="flex justify-end gap-2"><Dialog.Close render={props=><Button {...props} variant="secondary">Cancel</Button>}/><Button type="submit" variant="primary" disabled={!newFolderName.trim()}>Create</Button></div></form></Dialog></Dialog.Root>
 </aside>;
}
