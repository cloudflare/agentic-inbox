// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader, Select, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
	useDeleteMembership,
	useMailboxMemberships,
	useUpdateMembership,
} from "~/queries/mailbox-access";
import { useCreateMailbox, useMailboxes } from "~/queries/mailboxes";
import { useMe, useUpdateUser, useUsers } from "~/queries/auth";
import type { AppUser, GlobalRole, MailboxMembership, UserStatus } from "~/types";

const USER_STATUSES: UserStatus[] = ["pending", "active", "disabled"];
const GLOBAL_ROLES: GlobalRole[] = ["none", "admin"];
const MAILBOX_ROLES: MailboxMembership["role"][] = ["manager", "responder", "viewer"];

export default function AdminRoute() {
	const navigate = useNavigate();
	const toastManager = useKumoToastManager();
	const { data: me, isLoading: isMeLoading } = useMe();
	const isAdmin = me?.user?.status === "active" && me.user.globalRole === "admin";
	const { data: users = [], isLoading: isUsersLoading } = useUsers(isAdmin);
	const { data: mailboxes = [], isLoading: isMailboxesLoading } = useMailboxes(isAdmin);
	const [mailboxEmail, setMailboxEmail] = useState("");
	const [mailboxName, setMailboxName] = useState("");
	const [selectedMailboxId, setSelectedMailboxId] = useState("");
	const [memberEmail, setMemberEmail] = useState("");
	const [memberRole, setMemberRole] = useState<MailboxMembership["role"]>("viewer");
	const updateUser = useUpdateUser();
	const createMailbox = useCreateMailbox();
	const updateMembership = useUpdateMembership();
	const deleteMembership = useDeleteMembership();

	const selectedMailbox = useMemo(
		() => mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? null,
		[mailboxes, selectedMailboxId],
	);
	const { data: memberships = [], isLoading: isMembershipsLoading } =
		useMailboxMemberships(selectedMailboxId, isAdmin && !!selectedMailboxId);

	useEffect(() => {
		if (!selectedMailboxId && mailboxes.length > 0) {
			setSelectedMailboxId(mailboxes[0]?.id ?? "");
		}
	}, [mailboxes, selectedMailboxId]);

	const patchUser = async (
		user: AppUser,
		data: { status?: UserStatus; globalRole?: GlobalRole },
	) => {
		try {
			await updateUser.mutateAsync({ userId: user.id, data });
			toastManager.add({ title: "User updated" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to update user";
			toastManager.add({ title: message, variant: "error" });
		}
	};

	const handleCreateMailbox = async (event: FormEvent) => {
		event.preventDefault();
		const email = mailboxEmail.trim().toLowerCase();
		if (!email) return;
		try {
			const name = mailboxName.trim() || email.split("@")[0] || email;
			const mailbox = await createMailbox.mutateAsync({ email, name });
			setMailboxEmail("");
			setMailboxName("");
			setSelectedMailboxId(mailbox.id);
			toastManager.add({ title: "Mailbox created" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create mailbox";
			toastManager.add({ title: message, variant: "error" });
		}
	};

	const handleGrantMember = async (event: FormEvent) => {
		event.preventDefault();
		if (!selectedMailbox || !memberEmail.trim()) return;
		try {
			await updateMembership.mutateAsync({
				mailboxId: selectedMailbox.id,
				userIdOrEmail: memberEmail.trim(),
				role: memberRole,
			});
			setMemberEmail("");
			toastManager.add({ title: "Mailbox access updated" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to update mailbox access";
			toastManager.add({ title: message, variant: "error" });
		}
	};

	if (isMeLoading) {
		return (
			<div className="min-h-screen bg-kumo-recessed flex items-center justify-center">
				<Loader size="lg" />
			</div>
		);
	}

	if (!isAdmin) {
		return (
			<div className="min-h-screen bg-kumo-recessed">
				<div className="mx-auto max-w-xl px-4 py-12">
					<Button
						variant="ghost"
						size="sm"
						icon={<ArrowLeftIcon size={16} />}
						onClick={() => navigate("/")}
						className="mb-4"
					>
						Mailboxes
					</Button>
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-6">
						<h1 className="text-lg font-semibold text-kumo-default mb-2">
							Admin required
						</h1>
						<p className="text-sm text-kumo-subtle">
							This area is limited to manually seeded global admins.
						</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-12">
				<div className="mb-6 flex items-center justify-between gap-3">
					<div>
						<Button
							variant="ghost"
							size="sm"
							icon={<ArrowLeftIcon size={16} />}
							onClick={() => navigate("/")}
							className="mb-3"
						>
							Mailboxes
						</Button>
						<h1 className="text-2xl font-bold text-kumo-default">
							Admin
						</h1>
						<p className="text-sm text-kumo-subtle mt-1">
							Approve users, create mailboxes, and grant mailbox roles.
						</p>
					</div>
				</div>

				<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
					<section className="rounded-lg border border-kumo-line bg-kumo-base overflow-hidden">
						<div className="border-b border-kumo-line px-5 py-4">
							<h2 className="text-base font-semibold text-kumo-default">Users</h2>
						</div>
						{isUsersLoading ? (
							<div className="flex justify-center py-16">
								<Loader size="lg" />
							</div>
						) : users.length === 0 ? (
							<div className="px-5 py-12 text-center text-sm text-kumo-subtle">
								No users yet.
							</div>
						) : (
							users.map((user, idx) => (
								<div
									key={user.id}
									className={`grid gap-3 px-5 py-4 md:grid-cols-[1fr_150px_130px] md:items-center ${
										idx > 0 ? "border-t border-kumo-line" : ""
									}`}
								>
									<div className="min-w-0">
										<div className="truncate text-sm font-medium text-kumo-default">
											{user.displayName || user.email}
										</div>
										<div className="truncate text-sm text-kumo-subtle">
											{user.email}
										</div>
									</div>
									<Select
										aria-label={`Status for ${user.email}`}
										value={user.status}
										onValueChange={(value) => {
											if (value && USER_STATUSES.includes(value as UserStatus)) {
												patchUser(user, { status: value as UserStatus });
											}
										}}
									>
										{USER_STATUSES.map((status) => (
											<Select.Option key={status} value={status}>
												{status}
											</Select.Option>
										))}
									</Select>
									<Select
										aria-label={`Global role for ${user.email}`}
										value={user.globalRole}
										onValueChange={(value) => {
											if (value && GLOBAL_ROLES.includes(value as GlobalRole)) {
												patchUser(user, { globalRole: value as GlobalRole });
											}
										}}
									>
										{GLOBAL_ROLES.map((role) => (
											<Select.Option key={role} value={role}>
												{role}
											</Select.Option>
										))}
									</Select>
								</div>
							))
						)}
					</section>

					<div className="space-y-5">
						<section className="rounded-lg border border-kumo-line bg-kumo-base p-5">
							<h2 className="text-base font-semibold text-kumo-default mb-4">Mailboxes</h2>
							<form onSubmit={handleCreateMailbox} className="space-y-3">
								<Input
									label="Mailbox email"
									type="email"
									value={mailboxEmail}
									onChange={(event) => setMailboxEmail(event.target.value)}
									placeholder="support@example.com"
									required
								/>
								<Input
									label="Display name"
									value={mailboxName}
									onChange={(event) => setMailboxName(event.target.value)}
									placeholder="Support"
								/>
								<div className="flex justify-end">
									<Button
										type="submit"
										variant="primary"
										loading={createMailbox.isPending}
										disabled={!mailboxEmail.trim()}
									>
										Create Mailbox
									</Button>
								</div>
							</form>
						</section>

						<section className="rounded-lg border border-kumo-line bg-kumo-base p-5">
							<h2 className="text-base font-semibold text-kumo-default mb-4">Mailbox Access</h2>
							{isMailboxesLoading ? (
								<div className="flex justify-center py-10">
									<Loader />
								</div>
							) : mailboxes.length === 0 ? (
								<p className="text-sm text-kumo-subtle">No mailboxes yet.</p>
							) : (
								<div className="space-y-4">
									<Select
										aria-label="Mailbox"
										value={selectedMailboxId}
										onValueChange={(value) => {
											if (value) setSelectedMailboxId(value);
										}}
									>
										{mailboxes.map((mailbox) => (
											<Select.Option key={mailbox.id} value={mailbox.id}>
												{mailbox.email}
											</Select.Option>
										))}
									</Select>
									<form onSubmit={handleGrantMember} className="grid gap-3">
										<Input
											label="User email"
											type="email"
											value={memberEmail}
											onChange={(event) => setMemberEmail(event.target.value)}
											placeholder="teammate@example.com"
											required
										/>
										<div className="grid grid-cols-[1fr_auto] gap-2">
											<Select
												aria-label="Mailbox role"
												value={memberRole}
												onValueChange={(value) => {
													if (value && MAILBOX_ROLES.includes(value as MailboxMembership["role"])) {
														setMemberRole(value as MailboxMembership["role"]);
													}
												}}
											>
												{MAILBOX_ROLES.map((role) => (
													<Select.Option key={role} value={role}>
														{role}
													</Select.Option>
												))}
											</Select>
											<Button
												type="submit"
												variant="primary"
												loading={updateMembership.isPending}
												disabled={!selectedMailbox || !memberEmail.trim()}
											>
												Grant
											</Button>
										</div>
									</form>
									<div className="rounded-md border border-kumo-line overflow-hidden">
										{isMembershipsLoading ? (
											<div className="flex justify-center py-8">
												<Loader />
											</div>
										) : memberships.length === 0 ? (
											<div className="px-4 py-6 text-center text-sm text-kumo-subtle">
												No direct grants yet.
											</div>
										) : (
											memberships.map((membership, idx) => (
												<div
													key={membership.userId}
													className={`grid gap-2 px-4 py-3 sm:grid-cols-[1fr_130px_auto] sm:items-center ${
														idx > 0 ? "border-t border-kumo-line" : ""
													}`}
												>
													<div className="min-w-0">
														<div className="truncate text-sm font-medium text-kumo-default">
															{membership.displayName || membership.email}
														</div>
														<div className="truncate text-xs text-kumo-subtle">
															{membership.email} - {membership.status}
														</div>
													</div>
													<Select
														aria-label={`Mailbox role for ${membership.email}`}
														value={membership.role}
														onValueChange={(value) => {
															if (
																selectedMailbox &&
																value &&
																MAILBOX_ROLES.includes(value as MailboxMembership["role"])
															) {
																updateMembership.mutate({
																	mailboxId: selectedMailbox.id,
																	userIdOrEmail: membership.userId,
																	role: value as MailboxMembership["role"],
																});
															}
														}}
													>
														{MAILBOX_ROLES.map((role) => (
															<Select.Option key={role} value={role}>
																{role}
															</Select.Option>
														))}
													</Select>
													<Button
														variant="ghost"
														size="sm"
														disabled={!selectedMailbox || deleteMembership.isPending}
														onClick={() => {
															if (selectedMailbox) {
																deleteMembership.mutate({
																	mailboxId: selectedMailbox.id,
																	userIdOrEmail: membership.userId,
																});
															}
														}}
													>
														Remove
													</Button>
												</div>
											))
										)}
									</div>
								</div>
							)}
						</section>
					</div>
				</div>

			</div>
		</div>
	);
}
