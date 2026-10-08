// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog, Input, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	CaretLeftIcon,
	FileIcon,
	FolderIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	PlusIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import { useCreateFolder, useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";

const FOLDER_ICONS: Record<string, React.ReactNode> = {
	[Folders.INBOX]: <TrayIcon size={18} weight="regular" />,
	[Folders.SENT]: <PaperPlaneTiltIcon size={18} weight="regular" />,
	[Folders.DRAFT]: <FileIcon size={18} weight="regular" />,
	[Folders.ARCHIVE]: <ArchiveIcon size={18} weight="regular" />,
	[Folders.TRASH]: <TrashIcon size={18} weight="regular" />,
};

const SYSTEM_FOLDER_LINKS = [
	{ id: Folders.INBOX, label: "Inbox" },
	{ id: Folders.SENT, label: "Sent" },
	{ id: Folders.DRAFT, label: "Drafts" },
	{ id: Folders.ARCHIVE, label: "Archive" },
	{ id: Folders.TRASH, label: "Trash" },
];

interface FolderLinkProps {
	to: string;
	icon: React.ReactNode;
	label: string;
	unreadCount?: number;
	onClick?: () => void;
}

function FolderLink({
	to,
	icon,
	label,
	unreadCount,
	onClick,
}: FolderLinkProps) {
	return (
		<NavLink
			to={to}
			onClick={onClick}
			className={({ isActive }) =>
				`flex h-8 items-center gap-2.5 px-2.5 rounded-lg text-sm transition-colors ${
					isActive
						? "bg-kumo-selected text-kumo-default font-medium"
						: "text-kumo-strong hover:bg-kumo-fill-hover hover:text-kumo-default"
				}`
			}
		>
			{({ isActive }) => (
				<>
					<span
						className={`flex shrink-0 items-center ${
							isActive ? "text-kumo-brand" : "text-kumo-subtle"
						}`}
					>
						{icon}
					</span>
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{unreadCount != null && unreadCount > 0 && (
						<span
							className={`ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums text-kumo-strong ${
								isActive ? "bg-kumo-base" : "bg-kumo-fill"
							}`}
						>
							{unreadCount}
						</span>
					)}
				</>
			)}
		</NavLink>
	);
}

function FolderSectionHeader({ onAdd }: { onAdd: () => void }) {
	return (
		<div className="flex h-7 items-center justify-between pl-2.5 pr-1 mb-0.5">
			<span className="text-xs font-medium text-kumo-subtle">Folders</span>
			<Tooltip content="New folder" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<PlusIcon size={14} />}
					onClick={onAdd}
					aria-label="Create new folder"
					className="size-6 rounded-lg text-kumo-subtle hover:bg-kumo-fill-hover hover:text-kumo-default"
				/>
			</Tooltip>
		</div>
	);
}

/** Up to two initials from the display name; falls back to the address. */
function getInitials(name: string | undefined, address: string | undefined) {
	const words = (name ?? "").split(/[\s._-]+/).filter(Boolean);
	const fromName = words
		.slice(0, 2)
		.map((word) => Array.from(word)[0] ?? "")
		.join("");
	const initials = fromName || Array.from(address ?? "")[0] || "";
	return initials.toUpperCase();
}

export default function Sidebar() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const { data: folders = [] } = useFolders(mailboxId);
	const createFolderMutation = useCreateFolder();
	const { startCompose, closeSidebar } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");

	const customFolders = useMemo(
		() =>
			folders.filter((f) => !(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id)),
		[folders],
	);

	const getUnreadCount = (folderId: string) => {
		const found = folders.find((f) => f.id === folderId);
		return found?.unreadCount || 0;
	};

	const handleCreateFolder = (e: React.FormEvent) => {
		e.preventDefault();
		if (newFolderName.trim() && mailboxId) {
			createFolderMutation.mutate({ mailboxId, name: newFolderName.trim() });
			setNewFolderName("");
			setIsCreateFolderOpen(false);
		}
	};

	const displayName = useMemo(() => {
		if (!currentMailbox) return mailboxId?.split("@")[0] || "Mailbox";
		// Prefer settings.fromName > name > local part of email
		if (currentMailbox.settings?.fromName) {
			return currentMailbox.settings.fromName;
		}
		if (currentMailbox.name && currentMailbox.name !== currentMailbox.email) {
			return currentMailbox.name;
		}
		return currentMailbox.email.split("@")[0] || currentMailbox.name;
	}, [currentMailbox, mailboxId]);

	const handleNavClick = () => {
		// Close mobile sidebar on navigation
		closeSidebar();
	};

	return (
		<aside className="h-full w-full bg-kumo-sidebar flex flex-col">
			{/* Back + identity */}
			<div className="px-3 pt-4 pb-3">
				<button
					type="button"
					onClick={() => {
						navigate("/");
						closeSidebar();
					}}
					className="flex items-center gap-1 px-1 text-xs text-kumo-subtle hover:text-kumo-default transition-colors mb-3 cursor-pointer bg-transparent border-0 py-0"
				>
					<CaretLeftIcon size={12} />
					<span>Mailboxes</span>
				</button>
				<div className="flex items-center gap-2.5 px-1">
					<div
						aria-hidden="true"
						className="flex size-8 shrink-0 items-center justify-center rounded-full bg-kumo-accent-soft text-xs font-medium text-kumo-accent"
					>
						{getInitials(displayName, currentMailbox?.email || mailboxId)}
					</div>
					<div className="min-w-0">
						<div className="text-sm font-medium text-kumo-default truncate">
							{displayName}
						</div>
						<div className="text-xs text-kumo-subtle truncate">
							{currentMailbox?.email || mailboxId}
						</div>
					</div>
				</div>
			</div>

			{/* Compose */}
			<div className="px-3 pb-3">
				<Button
					variant="primary"
					icon={<PencilSimpleIcon size={16} />}
					onClick={() => startCompose()}
					className="w-full h-9 rounded-lg"
				>
					Compose
				</Button>
			</div>

			{/* Navigation */}
			<nav className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5">
				{SYSTEM_FOLDER_LINKS.map((folder) => (
					<FolderLink
						key={folder.id}
						to={`/mailbox/${mailboxId}/emails/${folder.id}`}
						icon={FOLDER_ICONS[folder.id]}
						label={folder.label}
						unreadCount={folder.id === Folders.TRASH ? 0 : getUnreadCount(folder.id)}
						onClick={handleNavClick}
					/>
				))}

				{/* Custom folders */}
				{customFolders.length > 0 && (
					<div className="pt-5">
						<FolderSectionHeader onAdd={() => setIsCreateFolderOpen(true)} />
						<div className="space-y-0.5">
							{customFolders.map((folder) => (
								<FolderLink
									key={folder.id}
									to={`/mailbox/${mailboxId}/emails/${folder.id}`}
									icon={<FolderIcon size={18} weight="regular" />}
									label={folder.name}
									unreadCount={folder.unreadCount}
									onClick={handleNavClick}
								/>
							))}
						</div>
					</div>
				)}

				{/* Add folder button when no custom folders */}
				{customFolders.length === 0 && (
					<div className="pt-5">
						<FolderSectionHeader onAdd={() => setIsCreateFolderOpen(true)} />
					</div>
				)}
			</nav>

			{/* Create folder dialog */}
			<Dialog.Root
				open={isCreateFolderOpen}
				onOpenChange={setIsCreateFolderOpen}
			>
				<Dialog size="sm" className="p-5">
					<Dialog.Title className="text-base font-medium text-kumo-default mb-4">
						Create folder
					</Dialog.Title>
					<form onSubmit={handleCreateFolder} className="space-y-4">
						<Input
							label="Folder name"
							placeholder="e.g. Projects"
							value={newFolderName}
							onChange={(e) => setNewFolderName(e.target.value)}
							required
						/>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={!newFolderName.trim()}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</aside>
	);
}
