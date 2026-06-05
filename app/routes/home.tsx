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
import { EnvelopeIcon, PlusIcon, ShieldCheckIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import { useMe, useRegister } from "~/queries/auth";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

function AccessStateCard({
	title,
	description,
	action,
}: {
	title: string;
	description: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base py-14 px-6">
			<div className="flex flex-col items-center text-center">
				<div className="mb-4">
					<ShieldCheckIcon size={44} weight="thin" className="text-kumo-subtle" />
				</div>
				<h1 className="text-lg font-semibold text-kumo-default mb-2">
					{title}
				</h1>
				<p className="text-sm text-kumo-subtle max-w-sm mb-5">
					{description}
				</p>
				{action}
			</div>
		</div>
	);
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const navigate = useNavigate();
	const { data: me, isLoading: isMeLoading } = useMe();
	const isAdmin = me?.user?.globalRole === "admin" && me.user.status === "active";
	const isActive = me?.user?.status === "active";
	const register = useRegister();
	const { data: mailboxes = [], refetch: refetchMailboxes } = useMailboxes(isActive);
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});

	const domains = configData?.domains ?? [];
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

	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) setSelectedDomain(domains[0]);
	}, [domains, selectedDomain]);

	const handleRegister = async () => {
		try {
			await register.mutateAsync();
			toastManager.add({ title: "Registration submitted" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Registration failed";
			toastManager.add({ title: message, variant: "error" });
		}
	};

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newPrefix || !selectedDomain) {
			setCreateError("Fill in the email address");
			return;
		}
		const email = `${newPrefix}@${selectedDomain}`;
		const name = newName || newPrefix;
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: "Mailbox created" });
			setIsCreateOpen(false);
			setNewPrefix("");
			setNewName("");
			refetchMailboxes();
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

	if (isMeLoading || !me) {
		return (
			<div className="min-h-screen bg-kumo-recessed flex items-center justify-center">
				<Loader size="lg" />
			</div>
		);
	}

	if (me.registrationStatus === "unregistered") {
		return (
			<div className="min-h-screen bg-kumo-recessed">
				<div className="mx-auto max-w-xl px-4 py-12 md:py-20">
					<AccessStateCard
						title="Register this email"
						description={`Cloudflare Access identified ${me.identity.email}. Register it here so an admin can approve mailbox access.`}
						action={
							<Button
								variant="primary"
								loading={register.isPending}
								onClick={handleRegister}
							>
								Register
							</Button>
						}
					/>
				</div>
			</div>
		);
	}

	if (me.registrationStatus === "pending") {
		return (
			<div className="min-h-screen bg-kumo-recessed">
				<div className="mx-auto max-w-xl px-4 py-12 md:py-20">
					<AccessStateCard
						title="Approval pending"
						description="Your account is registered. A global admin needs to activate it and grant mailbox access."
					/>
				</div>
			</div>
		);
	}

	if (me.registrationStatus === "disabled") {
		return (
			<div className="min-h-screen bg-kumo-recessed">
				<div className="mx-auto max-w-xl px-4 py-12 md:py-20">
					<AccessStateCard
						title="Account disabled"
						description="This account cannot access Dumb Inbox. Contact a global admin."
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8">
					<div className="flex items-center justify-between gap-3">
						<div>
							<h1 className="text-2xl font-bold text-kumo-default">Mailboxes</h1>
							<p className="text-sm text-kumo-subtle mt-1">
								{me.user?.email}
							</p>
						</div>
						<div className="flex items-center gap-2">
							{isAdmin && (
								<Button variant="secondary" onClick={() => navigate("/admin")}>
									Admin
								</Button>
							)}
							{isAdmin && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									New Mailbox
								</Button>
							)}
						</div>
					</div>
					{domains.length > 0 && (
						<p className="text-sm text-kumo-subtle mt-1">
							{domains.join(", ")}
						</p>
					)}
				</div>

				{mailboxes.length > 0 ? (
					<div className="rounded-lg border border-kumo-line bg-kumo-base overflow-hidden">
						{mailboxes.map((account, idx) => (
							<RouterLink
								key={account.id}
								to={`/mailbox/${account.id}`}
								className={`group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint ${
									idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									{account.name.charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium text-kumo-default truncate">
										{account.name}
									</div>
									<div className="text-sm text-kumo-subtle">
										{account.email}
									</div>
								</div>
								{isAdmin && (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										aria-label={`Delete mailbox ${account.email}`}
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
							</RouterLink>
						))}
					</div>
				) : (
					<div className="rounded-lg border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon
									size={48}
									weight="thin"
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No mailboxes available
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{isAdmin
									? "Create a mailbox or grant access to an existing one."
									: "A mailbox manager or global admin needs to grant access."}
							</p>
							{isAdmin && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									Create Mailbox
								</Button>
							)}
						</div>
					</div>
				)}
			</div>

			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						Create mailbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div>
							<span className="text-sm font-medium text-kumo-default mb-1.5 block">
								Email address
							</span>
							<div className="flex items-center gap-2">
								<div className="flex-1">
									<Input
										aria-label="Address prefix"
										placeholder="info"
										size="sm"
										value={newPrefix}
										onChange={(e) => setNewPrefix(e.target.value)}
										required
									/>
								</div>
								<span className="text-sm text-kumo-subtle">@</span>
								{domains.length > 1 ? (
									<div className="flex-1">
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
									<span className="text-sm text-kumo-subtle">
										{selectedDomain || "no domain"}
									</span>
								)}
							</div>
						</div>
						<Input
							label="Display name"
							placeholder="Info"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={!selectedDomain}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete mailbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? Mail rows and attachment blobs are not purged yet.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
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
