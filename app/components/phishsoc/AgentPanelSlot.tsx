// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useUIStore } from "~/hooks/useUIStore";

// Agent panel layout slot. Owns the in-flow vs slide-over decision so the
// Shell stays declarative.
//
//   xl+ (≥1280px): renders an in-flow `<aside>` column. The reading pane
//                  reflows to share space — no overlay, no dialog semantics.
//   < xl:          renders a slide-over via base-ui Dialog. Focus trap,
//                  scroll lock, Escape, and click-outside dismissal all come
//                  from base-ui (kumo's Dialog wraps this same primitive).
//
// Resizing across the breakpoint remounts the panel, which resets local UI
// state (input value, tab selection). Chat history persists in the durable
// agent, so the conversation itself isn't lost.
const XL_BREAKPOINT_QUERY = "(min-width: 1280px)";

interface AgentPanelSlotProps {
	rightPanel: ReactNode;
}

export default function AgentPanelSlot({ rightPanel }: AgentPanelSlotProps) {
	const isAgentPanelOpen = useUIStore((s) => s.isAgentPanelOpen);
	const closeAgentPanel = useUIStore((s) => s.closeAgentPanel);
	const isXlUp = useMediaQuery(XL_BREAKPOINT_QUERY);

	if (!isAgentPanelOpen) return null;

	if (isXlUp) {
		return (
			<aside
				id="agent-panel"
				aria-label="Agent panel"
				className="hidden xl:flex w-[380px] shrink-0 flex-col bg-paper border-l border-line overflow-hidden"
			>
				{rightPanel}
			</aside>
		);
	}

	return (
		<BaseDialog.Root
			open={isAgentPanelOpen}
			onOpenChange={(open) => {
				if (!open) closeAgentPanel();
			}}
		>
			<BaseDialog.Portal>
				<BaseDialog.Backdrop
					data-agent-panel-backdrop
					className="fixed inset-0 z-40 bg-black/50 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
				/>
				<BaseDialog.Popup
					id="agent-panel"
					aria-label="Agent panel"
					aria-modal="true"
					className="fixed inset-y-0 right-0 z-50 flex w-[min(420px,90vw)] flex-col border-l border-line bg-paper shadow-xl outline-none transition-transform data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full"
				>
					{/* Floating close button rather than a header bar — AgentSidebar
					    already renders its own Agent/MCP tab bar at the top, and a
					    second header would stack visually. The button sits over the
					    tab row at the right edge so it's reachable without crowding
					    the tabs. */}
					<BaseDialog.Close
						aria-label="Close agent panel"
						className="absolute top-1.5 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink transition-colors bg-transparent border-0 cursor-pointer"
					>
						<XIcon size={14} weight="bold" />
					</BaseDialog.Close>
					<div className="flex-1 min-h-0 overflow-hidden">{rightPanel}</div>
				</BaseDialog.Popup>
			</BaseDialog.Portal>
		</BaseDialog.Root>
	);
}
