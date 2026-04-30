// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CaretLeftIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import ComposePanel from "~/components/ComposePanel";
import EmailPanel from "~/components/EmailPanel";
import { useUIStore } from "~/hooks/useUIStore";

interface MailboxSplitViewProps {
	selectedEmailId: string | null;
	isComposing: boolean;
	children: ReactNode;
}

export default function MailboxSplitView({
	selectedEmailId,
	isComposing,
	children,
}: MailboxSplitViewProps) {
	const isPanelOpen = selectedEmailId !== null || isComposing;
	const { closePanel, closeCompose } = useUIStore();

	// Mobile back-to-list returns from the detail/compose pane to the list.
	// Compose has its own close path that restores the previously-selected
	// email; for plain "email selected" we just clear the panel.
	const handleBackToList = () => {
		if (isComposing) {
			closeCompose();
			if (!selectedEmailId) closePanel();
		} else {
			closePanel();
		}
	};

	return (
		<div className="flex h-full">
			<div
				className={`flex flex-col min-w-0 shrink-0 ${
					isPanelOpen
						? "hidden md:flex md:w-[380px] md:border-r md:border-line"
						: "w-full"
				}`}
			>
				{children}
			</div>
			{isPanelOpen && (
				<div className="flex-1 flex flex-col min-w-0 overflow-hidden w-full md:w-auto">
					{/* Mobile-only back affordance. The desktop EmailPanelToolbar back
					    button is only visible at md+; on phones the list is hidden so
					    this row is the only escape back to the inbox. */}
					<button
						type="button"
						onClick={handleBackToList}
						className="md:hidden flex items-center gap-1 px-4 h-10 border-b border-line bg-paper text-[13px] text-ink-2 hover:text-ink"
					>
						<CaretLeftIcon size={14} />
						Back to list
					</button>
					{isComposing && !selectedEmailId ? (
						<ComposePanel />
					) : isComposing && selectedEmailId ? (
						<div className="flex flex-col h-full overflow-y-auto">
							<ComposePanel />
							<div className="border-t border-line">
								<EmailPanel emailId={selectedEmailId} />
							</div>
						</div>
					) : selectedEmailId ? (
						<EmailPanel emailId={selectedEmailId} />
					) : null}
				</div>
			)}
		</div>
	);
}
