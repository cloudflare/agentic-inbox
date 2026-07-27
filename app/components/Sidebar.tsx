// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Button,
	Dialog,
	Input,
	Tooltip,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	AddressBookTabsIcon,
	ArchiveIcon,
	CalendarCheckIcon,
	CaretLeftIcon,
	ClockIcon,
	FileIcon,
	FolderIcon,
	HourglassMediumIcon,
	LightningIcon,
	PaperPlaneTiltIcon,
	PaperclipIcon,
	PencilSimpleIcon,
	PlusIcon,
	TagIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import { NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import ManageLabelsDialog from "~/components/labels/ManageLabelsDialog";
import SavedViewsSidebarSection from "~/components/SavedViewsSidebarSection";
import { useOutboundAttentionCount } from "~/queries/emails";
import { useCreateFolder, useFolders } from "~/queries/folders";
import { useLabels } from "~/queries/labels";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import {
  canonicalCollapsedCreateName,
  CreateOperationIdentity,
} from "~/lib/create-operation-identity";
import { ApiError } from "~/services/api";

const FOLDER_ICONS: Record<string, React.ReactNode> = {
	[Folders.INBOX]: <TrayIcon size={18} weight="regular" />,
	[Folders.SENT]: <PaperPlaneTiltIcon size={18} weight="regular" />,
	[Folders.DRAFT]: <FileIcon size={18} weight="regular" />,
	[Folders.OUTBOX]: <HourglassMediumIcon size={18} weight="regular" />,
	[Folders.SNOOZED]: <ClockIcon size={18} weight="regular" />,
	[Folders.ARCHIVE]: <ArchiveIcon size={18} weight="regular" />,
	[Folders.TRASH]: <TrashIcon size={18} weight="regular" />,
};

const SYSTEM_FOLDER_LINKS = [
	{ id: Folders.INBOX, label: "Inbox" },
	{ id: Folders.SENT, label: "Sent" },
	{ id: Folders.DRAFT, label: "Drafts" },
	{ id: Folders.OUTBOX, label: "Outbox" },
	{ id: Folders.SNOOZED, label: "Snoozed" },
	{ id: Folders.ARCHIVE, label: "Archive" },
	{ id: Folders.TRASH, label: "Trash" },
];

interface FolderLinkProps {
	to: string;
	icon: React.ReactNode;
	label: string;
	unreadCount?: number;
	/** Deliveries that stalled or failed and need the user to act. */
	attentionCount?: number;
	onClick?: () => void;
	active?: boolean;
}

function FolderLink({
	to,
	icon,
	label,
	unreadCount,
	attentionCount,
	onClick,
	active,
}: FolderLinkProps) {
	return (
		<NavLink
			to={to}
			onClick={onClick}
			className={({ isActive }) =>
				`flex items-center gap-3 py-2 px-3 rounded-md text-sm transition-colors ${
					(active ?? isActive)
						? "bg-kumo-fill font-semibold text-kumo-default"
						: "text-kumo-strong hover:bg-kumo-tint"
				}`
			}
		>
			<span className="shrink-0">{icon}</span>
			<span className="truncate flex-1">{label}</span>
			{attentionCount != null && attentionCount > 0 ? (
				<Badge variant="destructive">
					{attentionCount}
					<span className="sr-only"> deliveries need attention</span>
				</Badge>
			) : (
				unreadCount != null &&
				unreadCount > 0 && <Badge variant="secondary">{unreadCount}</Badge>
			)}
		</NavLink>
	);
}

export default function Sidebar() {
	const { mailboxId, folder: currentFolder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const {
		data: folders = [],
		isError: foldersError,
		refetch: refetchFolders,
	} = useFolders(mailboxId);
	const {
		data: labels = [],
		isError: labelsError,
		refetch: refetchLabels,
	} = useLabels(mailboxId);
	const createFolderMutation = useCreateFolder();
	const toastManager = useKumoToastManager();
	const { startCompose, closeSidebar } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const outboundAttentionCount = useOutboundAttentionCount(mailboxId);
	const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
	const [isManageLabelsOpen, setIsManageLabelsOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
  const [createFolderError, setCreateFolderError] = useState("");
  const createFolderIdentity = useRef(new CreateOperationIdentity());
	const selectedLabelId = searchParams.get("label_id");

	const customFolders = useMemo(
		() =>
			folders.filter(
				(f) => !(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id),
			),
		[folders],
	);

	const getUnreadCount = (folderId: string) => {
		const found = folders.find((f) => f.id === folderId);
		return found?.unreadCount || 0;
	};

	// Reopening the dialog starts a fresh attempt, so the last one's name and
	// error never greet the next create. The operation identity is kept: a
	// retype of the same name still recovers an uncertain create.
	const openCreateFolder = () => {
		setNewFolderName("");
		setCreateFolderError("");
		setIsCreateFolderOpen(true);
	};

	const handleCreateFolder = (e: React.FormEvent) => {
		e.preventDefault();
    const folderName = canonicalCollapsedCreateName(newFolderName);
		if (!folderName || !mailboxId) return;
    setCreateFolderError("");
    const operationId = createFolderIdentity.current.operationIdFor([
      mailboxId.toLowerCase(),
      "folder",
      folderName,
    ]);
		createFolderMutation.mutate(
      { mailboxId, name: folderName, operationId },
			{
        onSuccess: (result) => {
          toastManager.add({
            title: `${result.replayed ? "Recovered" : "Created"} ${folderName}`,
          });
          createFolderIdentity.current.invalidate();
					setNewFolderName("");
          setCreateFolderError("");
					setIsCreateFolderOpen(false);
				},
				onError: (error) => {
          const code =
            error instanceof ApiError ? String(error.body.code ?? "") : "";
          const message =
            code === "creation_superseded"
              ? "This folder was created and later renamed. It was not overwritten. Change the name to create another folder."
              : code === "creation_unavailable"
                ? "This folder was created and later deleted. It was not recreated. Change the name to create another folder."
                : code === "create_idempotency_conflict"
                  ? "This recovery no longer matches the original folder. Change the name to start a new create."
                  : error instanceof ApiError
                    ? error.message
                    : "We couldn’t confirm whether the folder was created. Retry with the same name to recover it safely.";
          setCreateFolderError(message);
				},
			},
		);
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
		<aside className="h-full w-64 bg-kumo-recessed flex flex-col shrink-0 border-r border-kumo-line">
			{/* Back + identity */}
			<div className="px-4 pt-4 pb-1">
				<button
					type="button"
					onClick={() => {
						navigate("/mailboxes");
						closeSidebar();
					}}
					className="flex items-center gap-1.5 text-kumo-subtle text-sm hover:text-kumo-default transition-colors mb-2.5 cursor-pointer bg-transparent border-0 p-0"
				>
					<CaretLeftIcon size={14} />
					<span>Mailboxes</span>
				</button>
				<div className="px-1">
					<div className="text-base font-semibold text-kumo-default truncate">
						{displayName}
					</div>
					<div className="text-sm text-kumo-subtle truncate mt-0.5">
						{currentMailbox?.email || mailboxId}
					</div>
				</div>
			</div>

			{/* Compose */}
			<div className="px-3 py-3">
				<Button
					variant="primary"
					icon={<PencilSimpleIcon size={16} />}
					onClick={() => startCompose()}
					className="w-full"
				>
					Compose
				</Button>
			</div>

			{/* Navigation */}
			<nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
				<FolderLink
					to={`/mailbox/${mailboxId}/today`}
					icon={<CalendarCheckIcon size={18} weight="regular" />}
					label="Today"
					onClick={handleNavClick}
				/>
				<FolderLink
					to={`/mailbox/${mailboxId}/people`}
					icon={<AddressBookTabsIcon size={18} weight="regular" />}
					label="People"
					onClick={handleNavClick}
				/>
				<FolderLink
					to={`/mailbox/${mailboxId}/attachments`}
					icon={<PaperclipIcon size={18} weight="regular" />}
					label="Files"
					onClick={handleNavClick}
				/>
				<FolderLink
					to={`/mailbox/${mailboxId}/automations`}
					icon={<LightningIcon size={18} weight="regular" />}
					label="Automations"
					onClick={handleNavClick}
				/>
				<div className="my-2 border-t border-kumo-line" aria-hidden="true" />
				{SYSTEM_FOLDER_LINKS.map((folder) => (
					<FolderLink
						key={folder.id}
						to={`/mailbox/${mailboxId}/emails/${folder.id}`}
						icon={FOLDER_ICONS[folder.id]}
						label={folder.label}
						unreadCount={getUnreadCount(folder.id)}
						attentionCount={
							folder.id === Folders.OUTBOX ? outboundAttentionCount : 0
						}
						active={!selectedLabelId && folder.id === currentFolder}
						onClick={handleNavClick}
					/>
				))}

				{/* A failed folder fetch must not read as an empty, count-free mailbox. */}
				{foldersError && (
					<p role="alert" className="px-3 pt-3 text-xs leading-5 text-kumo-subtle">
						Folders didn’t load, so unread counts and your own folders are
						missing.{" "}
						<button
							type="button"
							onClick={() => void refetchFolders()}
							className="min-h-11 rounded px-1 font-medium text-kumo-brand underline underline-offset-2"
						>
							Try again
						</button>
					</p>
				)}

				{/* Custom folders */}
				{customFolders.length > 0 && (
					<div className="pt-5">
						<div className="flex items-center justify-between px-3 mb-1.5">
							<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
								Folders
							</span>
							<Tooltip content="New folder" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<PlusIcon size={16} />}
									onClick={openCreateFolder}
									aria-label="Create new folder"
								/>
							</Tooltip>
						</div>
						{customFolders.map((folder) => (
							<FolderLink
								key={folder.id}
								to={`/mailbox/${mailboxId}/emails/${folder.id}`}
								icon={<FolderIcon size={18} />}
								label={folder.name}
								unreadCount={folder.unreadCount}
								active={!selectedLabelId && folder.id === currentFolder}
								onClick={handleNavClick}
							/>
						))}
					</div>
				)}

				{/* Add folder button when no custom folders */}
				{customFolders.length === 0 && (
					<div className="pt-5">
						<div className="flex items-center justify-between px-3 mb-1.5">
							<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
								Folders
							</span>
							<Tooltip content="New folder" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<PlusIcon size={16} />}
									onClick={openCreateFolder}
									aria-label="Create new folder"
								/>
							</Tooltip>
						</div>
					</div>
				)}

				{mailboxId && (
					<SavedViewsSidebarSection
						mailboxId={mailboxId}
						onNavigate={handleNavClick}
					/>
				)}

				<div className="pt-5">
					<div className="flex items-center justify-between px-3 mb-1.5">
						<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
							Labels
						</span>
						<Tooltip content="Manage labels" asChild>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<PlusIcon size={16} />}
								onClick={() => setIsManageLabelsOpen(true)}
								aria-label="Manage mailbox labels"
							/>
						</Tooltip>
					</div>
					{labels.map((label) => (
						<FolderLink
							key={label.id}
							to={`/mailbox/${mailboxId}/emails/${currentFolder || Folders.INBOX}?label_id=${encodeURIComponent(label.id)}`}
							icon={
								<TagIcon
									size={18}
									weight={selectedLabelId === label.id ? "fill" : "regular"}
								/>
							}
							label={label.name}
							active={selectedLabelId === label.id}
							onClick={handleNavClick}
						/>
					))}
					{labelsError ? (
						<p role="alert" className="px-3 py-1 text-xs leading-5 text-kumo-subtle">
							Labels didn’t load.{" "}
							<button
								type="button"
								onClick={() => void refetchLabels()}
								className="min-h-11 rounded px-1 font-medium text-kumo-brand underline underline-offset-2"
							>
								Try again
							</button>
						</p>
					) : labels.length === 0 ? (
						<button
							type="button"
							className="w-full rounded-md px-3 py-2 text-left text-sm text-kumo-subtle hover:bg-kumo-tint"
							onClick={() => setIsManageLabelsOpen(true)}
						>
							Create your first label
						</button>
					) : null}
				</div>
			</nav>

			{mailboxId && (
				<ManageLabelsDialog
					mailboxId={mailboxId}
					open={isManageLabelsOpen}
					onOpenChange={setIsManageLabelsOpen}
				/>
			)}

			{/* Create folder dialog */}
			<Dialog.Root
				open={isCreateFolderOpen}
				onOpenChange={(open) => {
					if (!createFolderMutation.isPending) setIsCreateFolderOpen(open);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Create folder
					</Dialog.Title>
					<form onSubmit={handleCreateFolder} className="space-y-4">
						<Input
							label="Folder name"
							placeholder="e.g. Projects"
							value={newFolderName}
              onChange={(e) => {
                const nextName = e.target.value;
                const intentChanged =
                  createFolderIdentity.current.invalidateIfIntentChanged([
                    mailboxId?.toLowerCase(),
                    "folder",
                    canonicalCollapsedCreateName(nextName),
                  ]);
                if (intentChanged) setCreateFolderError("");
                setNewFolderName(nextName);
              }}
							disabled={createFolderMutation.isPending}
							required
						/>
            {createFolderError && (
              <p role="alert" className="text-sm text-kumo-danger">
                {createFolderError}
              </p>
            )}
						<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<Dialog.Close
								render={(props) => (
									<Button
										{...props}
										variant="secondary"
										disabled={createFolderMutation.isPending}
										className="w-full sm:w-auto"
									>
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={!newFolderName.trim() || createFolderMutation.isPending}
								loading={createFolderMutation.isPending}
								className="w-full sm:w-auto"
							>
								{createFolderMutation.isPending ? "Creating" : "Create"}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</aside>
	);
}
