// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Input,
	Loader,
	Select,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	CaretRightIcon,
	EnvelopeIcon,
	EnvelopeSimpleIcon,
	PlusIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import ThemeToggle from "~/components/ThemeToggle";
import api from "~/services/api";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";

export function meta() {
	return [{ title: "Agentic Inbox" }];
}

// Up to two initials from the display name ("Julius Yolo" -> "JY", "hello@x.com" -> "H").
function getInitials(name: string, email: string) {
	// Mailbox names are often the address itself; only the local part is a name.
	const letters = name
		.split("@")[0]
		.trim()
		.split(/[\s._-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => word.charAt(0))
		.join("");
	return (letters || email.charAt(0)).toUpperCase();
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const { data: mailboxes = [], refetch: refetchMailboxes, isFetched: mailboxesFetched } = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// Set default domain when config loads
	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) {
			setSelectedDomain(domains[0]);
		}
	}, [domains, selectedDomain]);

	// Auto-create mailboxes from config (run once when both data sources are ready)
	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (emailAddresses.length === 0 || !mailboxesFetched) return;
		const existingEmails = new Set(
			mailboxes.map((m) => m.email.toLowerCase()),
		);
		const toCreate = emailAddresses.filter(
			(addr) => !existingEmails.has(addr.toLowerCase()),
		);
		if (toCreate.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		autoCreateDone.current = true;
		let cancelled = false;
		Promise.all(
			toCreate.map((addr) => {
				const localPart = addr.split("@")[0] || addr;
				return api.createMailbox(addr, localPart).catch(() => {});
			}),
		).then(() => { if (!cancelled) refetchMailboxes(); });
		return () => { cancelled = true; };
	}, [emailAddresses, mailboxes, refetchMailboxes]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Please fill in all fields");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
		const name = newName || newPrefix;
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: "Mailbox created successfully!" });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create mailbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "Mailbox deleted" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({ title: "Failed to delete mailbox", variant: "error" });
		} finally {
			setIsDeleting(false);
		}
	};

	const isConfigured = emailAddresses.length > 0;
	const accounts = isConfigured
		? emailAddresses.map((addr) => ({
				id: addr,
				email: addr,
				name: addr.split("@")[0] || addr,
			}))
		: mailboxes;

	const isLoading = !configData;

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<header className="flex h-14 items-center gap-2.5 border-b border-kumo-line bg-kumo-base px-4 md:px-6">
				<div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-kumo-accent-soft text-kumo-accent">
					<EnvelopeSimpleIcon size={16} />
				</div>
				<span className="text-sm font-medium text-kumo-default">
					Agentic Inbox
				</span>
				<div className="ml-auto flex items-center">
					<ThemeToggle />
				</div>
			</header>

			<main className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-12">
				<div className="mb-6 flex items-center justify-between gap-4">
					<div className="min-w-0">
						<h1 className="text-2xl font-semibold tracking-tight text-kumo-default">
							Mailboxes
						</h1>
						{domains.length > 0 && (
							<p className="mt-1 break-words text-sm text-kumo-subtle">
								{domains.join(", ")}
							</p>
						)}
					</div>
					{!isConfigured && (
						<Button
							variant="primary"
							icon={<PlusIcon size={16} />}
							onClick={() => setIsCreateOpen(true)}
							className="shrink-0"
						>
							New Mailbox
						</Button>
					)}
				</div>

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" className="text-kumo-subtle" />
					</div>
				) : accounts.length > 0 ? (
					<div className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
						{accounts.map((account) => (
							<RouterLink
								key={account.id}
								to={`/mailbox/${account.id}`}
								className="group flex items-center gap-3 px-4 py-3 no-underline outline-none transition-colors hover:bg-kumo-tint focus-visible:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring"
							>
								<div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-kumo-accent-soft text-xs font-medium text-kumo-accent">
									{getInitials(account.name, account.email)}
								</div>
								<div className="min-w-0 flex-1">
									<div className="truncate text-sm font-medium text-kumo-default">
										{account.name}
									</div>
									{account.email !== account.name && (
										<div className="truncate text-xs text-kumo-subtle">
											{account.email}
										</div>
									)}
								</div>
								{!isConfigured && (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										aria-label={`Delete mailbox ${account.email}`}
										className="text-kumo-subtle hover:text-kumo-danger"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setMailboxToDelete({
												id: account.id,
												email: account.email,
											});
											setIsDeleteOpen(true);
										}}
									/>
								)}
								<CaretRightIcon
									size={14}
									className="shrink-0 text-kumo-inactive transition-colors group-hover:text-kumo-subtle"
								/>
							</RouterLink>
						))}
					</div>
				) : (
					<div className="flex flex-col items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base px-6 py-16 text-center">
						<EnvelopeIcon
							size={40}
							weight="light"
							className="mb-2 text-kumo-inactive"
						/>
						<h3 className="text-[15px] font-medium text-kumo-default">
							No mailboxes yet
						</h3>
						<p className="max-w-sm text-sm text-kumo-subtle">
							{isConfigured
								? "Your email routing is configured but no mailboxes have been created yet. They will appear here automatically."
								: "Create a mailbox to start sending and receiving emails with your domain."}
						</p>
						{!isConfigured && (
							<Button
								variant="primary"
								icon={<PlusIcon size={16} />}
								onClick={() => setIsCreateOpen(true)}
								className="mt-4"
							>
								Create Mailbox
							</Button>
						)}
					</div>
				)}
			</main>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-5">
					<Dialog.Title className="mb-4 text-base font-medium">
						Create New Mailbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div>
							<span className="mb-2 block text-base font-medium text-kumo-default">
								Email Address
							</span>
							<div className="flex items-center gap-2">
								<div className="min-w-0 flex-1">
									<Input
										aria-label="Address prefix"
										placeholder="info"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="min-w-0 flex-1">
										<Select
											aria-label="Domain"
											value={selectedDomain}
											onValueChange={(value) => {
												if (value) setSelectedDomain(value);
											}}
										>
											{domains.map((d) => (
												<Select.Option key={d} value={d}>
													{d}
												</Select.Option>
											))}
										</Select>
									</div>
								) : (
									<span className="truncate text-sm text-kumo-subtle">
										{selectedDomain || "no domain"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="Display Name (optional)"
							placeholder="Info"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
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
								loading={isCreating}
								disabled={!selectedDomain}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-5">
					<Dialog.Title className="mb-2 text-base font-medium">
						Delete Mailbox
					</Dialog.Title>
					<Dialog.Description className="mb-5 text-sm text-kumo-subtle">
						Are you sure you want to delete{" "}
						<strong className="font-medium text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? This action cannot be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							loading={isDeleting}
							onClick={handleDelete}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
