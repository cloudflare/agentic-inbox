// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useRef } from "react";
import { Folders } from "shared/folders";
import { useEmails } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useBrand } from "~/hooks/useBrand";

/**
 * Foreground new-mail notifications. Web Push owns the background/closed-app path.
 *
 * - Raises a toast the first time a newer inbound message appears (seeded
 *   silently on first load so existing mail never toasts). The mailbox change
 *   feed already polls and invalidates the emails cache, so this reads that
 *   cache rather than running a second poll of its own.
 * - Mirrors the total unread count into the browser tab title.
 */
export function useMailNotifications(mailboxId: string | undefined) {
	const toast = useKumoToastManager();
	const { appName: baseTitle } = useBrand();
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: folders = [] } = useFolders(mailboxId);
	const { data: inbox } = useEmails(
		mailboxId,
		{ folder: Folders.INBOX, page: "1", limit: "15" },
		{ enabled: !!mailboxId },
	);

	const myEmail = (mailbox?.email || mailboxId || "").toLowerCase();
	const lastInboundIdRef = useRef<string | null>(null);
	const primedRef = useRef(false);
	const mailboxKeyRef = useRef<string | undefined>(undefined);

	// Reset detection state when the mailbox changes.
	useEffect(() => {
		if (mailboxKeyRef.current !== mailboxId) {
			mailboxKeyRef.current = mailboxId;
			lastInboundIdRef.current = null;
			primedRef.current = false;
		}
	}, [mailboxId]);

	// Toast when a new inbound email appears.
	useEffect(() => {
		const emails = inbox?.emails;
		if (!emails || emails.length === 0) return;
		// The list is date-DESC, so the first message not sent by us is the newest inbound.
		const newestInbound = emails.find(
			(e) => (e.sender || "").toLowerCase() !== myEmail,
		);
		if (!newestInbound) return;

		if (!primedRef.current) {
			// First successful load — record the baseline without notifying.
			lastInboundIdRef.current = newestInbound.id;
			primedRef.current = true;
			return;
		}

		if (newestInbound.id !== lastInboundIdRef.current) {
			lastInboundIdRef.current = newestInbound.id;
			const fromName = (newestInbound.sender || "").split("@")[0] || "someone";
			const subject = newestInbound.subject || "(no subject)";
			toast.add({ title: `New email from ${fromName} — ${subject}` });
		}
	}, [inbox, myEmail, toast]);

	// Reflect total unread in the tab title.
	useEffect(() => {
		const unread = folders.reduce((sum, f) => sum + (f.unreadCount || 0), 0);
		document.title = unread > 0 ? `(${unread}) ${baseTitle}` : baseTitle;
		return () => {
			document.title = baseTitle;
		};
	}, [folders, baseTitle]);
}
