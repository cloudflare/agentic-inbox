// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader } from "@cloudflare/kumo";
import { useEffect, useRef } from "react";
import { Outlet, useNavigate, useParams } from "react-router";
import ComposeEmail from "~/components/ComposeEmail";
import Header from "~/components/Header";
import Sidebar from "~/components/Sidebar";
import { useUIStore } from "~/hooks/useUIStore";
import { useMailbox } from "~/queries/mailboxes";

export default function MailboxRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	// Prefetch mailbox data for child components
	const mailboxQuery = useMailbox(mailboxId);
	const prevMailboxIdRef = useRef<string | undefined>(undefined);
	const {
		isSidebarOpen,
		closeSidebar,
		closePanel,
		closeComposeModal,
	} = useUIStore();

	useEffect(() => {
		if (
			prevMailboxIdRef.current &&
			mailboxId &&
			prevMailboxIdRef.current !== mailboxId
		) {
			closePanel();
			closeComposeModal();
			closeSidebar();
		}

		prevMailboxIdRef.current = mailboxId;
	}, [mailboxId, closeComposeModal, closePanel, closeSidebar]);

	if (mailboxQuery.isLoading) {
		return (
			<div className="flex h-screen items-center justify-center bg-kumo-recessed">
				<Loader size="lg" />
			</div>
		);
	}

	if (mailboxQuery.isError || !mailboxQuery.data) {
		return (
			<div className="min-h-screen bg-kumo-recessed">
				<div className="mx-auto max-w-xl px-4 py-12">
					<Button variant="ghost" size="sm" onClick={() => navigate("/")} className="mb-4">
						Mailboxes
					</Button>
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-6">
						<h1 className="text-lg font-semibold text-kumo-default mb-2">
							Mailbox unavailable
						</h1>
						<p className="text-sm text-kumo-subtle">
							This mailbox does not exist or your account does not have access.
						</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-screen overflow-hidden">
			{/* Mobile sidebar overlay backdrop */}
			{isSidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-black/30 md:hidden"
					onClick={closeSidebar}
					onKeyDown={(e) => e.key === "Escape" && closeSidebar()}
					role="button"
					tabIndex={-1}
					aria-label="Close sidebar"
				/>
			)}

			{/* Sidebar: hidden on mobile by default, shown as overlay when open */}
			<div
				className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 md:z-0 ${
					isSidebarOpen ? "translate-x-0" : "-translate-x-full"
				}`}
			>
				<Sidebar />
			</div>

			{/* Main content */}
			<div className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				<Header />
				<main className="flex-1 overflow-hidden">
					<Outlet />
				</main>
			</div>

			<ComposeEmail />
		</div>
	);
}
