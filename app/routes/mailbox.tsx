// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { Outlet, useParams } from "react-router";
import { Folders } from "shared/folders";
import AgentSidebar from "~/components/AgentSidebar";
import ComposeEmail from "~/components/ComposeEmail";
import Shell from "~/components/phishsoc/Shell";
import { type MailboxEvent, useMailboxEvents } from "~/hooks/useMailboxEvents";
import { useMailbox } from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";

export default function MailboxRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	// Prefetch mailbox data for child components
	useMailbox(mailboxId);
	const prevMailboxIdRef = useRef<string | undefined>(undefined);
	const queryClient = useQueryClient();
	const { closeSidebar, closePanel, closeComposeModal, closeAgentPanel } = useUIStore();

	const handleMailboxEvent = useCallback(
		(event: MailboxEvent) => {
			if (!mailboxId || event.type !== "new-email") return;
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });

			// Quarantined / blocked mail still invalidates so the list updates
			// for users browsing Quarantine, but never raises a desktop toast.
			if (event.folder !== Folders.INBOX) return;
			if (typeof Notification === "undefined") return;
			if (Notification.permission !== "granted") return;
			if (typeof document !== "undefined" && document.visibilityState === "visible") return;

			try {
				new Notification("New email", {
					body: mailboxId,
					tag: event.id, // dedupe across multiple tabs viewing the same mailbox
					icon: "/favicon.svg",
				});
			} catch {
				// Some browsers throw if invoked outside a service worker; ignore.
			}
		},
		[mailboxId, queryClient],
	);
	useMailboxEvents(mailboxId, handleMailboxEvent);

	useEffect(() => {
		if (
			prevMailboxIdRef.current &&
			mailboxId &&
			prevMailboxIdRef.current !== mailboxId
		) {
			closePanel();
			closeComposeModal();
			closeSidebar();
			// Close the slide-over too — switching mailboxes mid-conversation
			// would otherwise leave a dialog open over a fresh mailbox context.
			closeAgentPanel();
		}

		prevMailboxIdRef.current = mailboxId;
	}, [mailboxId, closeComposeModal, closePanel, closeSidebar, closeAgentPanel]);

	return (
		<>
			<Shell rightPanel={<AgentSidebar />}>
				<Outlet />
			</Shell>
			<ComposeEmail />
		</>
	);
}
