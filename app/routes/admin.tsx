// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader, Select, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useNavigate } from "react-router";
import { useMe, useUpdateUser, useUsers } from "~/queries/auth";
import type { AppUser, GlobalRole, UserStatus } from "~/types";

const USER_STATUSES: UserStatus[] = ["pending", "active", "disabled"];
const GLOBAL_ROLES: GlobalRole[] = ["none", "admin"];

export default function AdminRoute() {
	const navigate = useNavigate();
	const toastManager = useKumoToastManager();
	const { data: me, isLoading: isMeLoading } = useMe();
	const isAdmin = me?.user?.status === "active" && me.user.globalRole === "admin";
	const { data: users = [], isLoading: isUsersLoading } = useUsers(isAdmin);
	const updateUser = useUpdateUser();

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
			<div className="mx-auto max-w-4xl px-4 py-8 md:px-6 md:py-12">
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
							Approve users and manage global admin status.
						</p>
					</div>
				</div>

				<div className="rounded-lg border border-kumo-line bg-kumo-base overflow-hidden">
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
								className={`grid gap-3 px-5 py-4 md:grid-cols-[1fr_180px_160px] md:items-center ${
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
				</div>
			</div>
		</div>
	);
}
