import { Button, Dialog } from "@cloudflare/kumo";
import { KeyboardIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
	activatesFocusedControl,
	isMailShortcutProtectedTarget,
	resolveMailShortcut,
	type MailCommand,
} from "~/lib/mail-keyboard";
import { useUIStore } from "~/hooks/useUIStore";

export const MAIL_COMMAND_EVENT = "mail-portal:command";
export const MAIL_FOCUS_SEARCH_EVENT = "mail-portal:focus-search";

const SHORTCUT_GROUPS: ReadonlyArray<{
	label: string;
	items: ReadonlyArray<readonly [string, string]>;
}> = [
	{
		label: "Move through mail",
		items: [
			["J / K", "Next / previous conversation"],
			["Enter", "Open conversation"],
			["Esc", "Close the current surface"],
		],
	},
	{
		label: "Work with mail",
		items: [
			["C", "Compose"],
			["R", "Reply"],
			["E", "Archive"],
			["#", "Move to Trash"],
			["U", "Mark read / unread"],
			["S", "Star / unstar"],
			["Z", "Snooze / return"],
			["/", "Search"],
			["⌘K / Ctrl K", "Open the command palette"],
		],
	},
	{
		label: "Go to",
		items: [
			["G then I", "Inbox"],
			["G then S", "Sent"],
			["G then D", "Drafts"],
			["G then A", "Archive"],
			["?", "Show this guide"],
		],
	},
];

function publish(command: MailCommand) {
	window.dispatchEvent(
		new CustomEvent<MailCommand>(MAIL_COMMAND_EVENT, { detail: command }),
	);
}

export default function MailKeyboardController() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const [showShortcuts, setShowShortcuts] = useState(false);
	const prefixRef = useRef<"g" | undefined>(undefined);
	const prefixTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const { startCompose, isComposing, selectedEmailId, closePanel } = useUIStore();

	// The command palette publishes onto the same bus as list-level keyboard
	// actions. Keep global commands here so every input surface has one owner.
	useEffect(() => {
		const onMailCommand = (event: Event) => {
			const command = (event as CustomEvent<MailCommand>).detail;
			switch (command) {
				case "compose":
					startCompose();
					return;
				case "focus-search":
					window.dispatchEvent(new Event(MAIL_FOCUS_SEARCH_EVENT));
					return;
				case "show-shortcuts":
					setShowShortcuts(true);
					return;
				default:
					return;
			}
		};

		window.addEventListener(MAIL_COMMAND_EVENT, onMailCommand);
		return () => window.removeEventListener(MAIL_COMMAND_EVENT, onMailCommand);
	}, [startCompose]);

	useEffect(() => {
		const resetPrefix = () => {
			prefixRef.current = undefined;
			if (prefixTimerRef.current) clearTimeout(prefixTimerRef.current);
			prefixTimerRef.current = null;
		};

		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.defaultPrevented) return;
			const resolution = resolveMailShortcut({
				key: event.key,
				isTextEntry: isMailShortcutProtectedTarget(event.target),
				isComposing: event.isComposing,
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				...(prefixRef.current
					? { pendingPrefix: prefixRef.current }
					: {}),
			});

			resetPrefix();
			if (resolution.nextPrefix) {
				event.preventDefault();
				prefixRef.current = resolution.nextPrefix;
				prefixTimerRef.current = setTimeout(resetPrefix, 1_200);
				return;
			}
			if (!resolution.command) return;
			// Enter belongs to whatever control has focus. Buttons, links and menu
			// items are unprotected above so shortcuts survive a focused mail row,
			// but that must not cost them their own activation.
			if (activatesFocusedControl(event.key, event.target)) return;
			if (isComposing) return;
			if (
				showShortcuts &&
				resolution.command !== "close-surface" &&
				resolution.command !== "show-shortcuts"
			) {
				return;
			}
			event.preventDefault();

			switch (resolution.command) {
				case "compose":
					startCompose();
					return;
				case "focus-search":
					window.dispatchEvent(new Event(MAIL_FOCUS_SEARCH_EVENT));
					return;
				case "show-shortcuts":
					setShowShortcuts(true);
					return;
				case "close-surface":
					if (showShortcuts) setShowShortcuts(false);
					else if (selectedEmailId) closePanel();
					return;
				case "go-inbox":
				case "go-sent":
				case "go-drafts":
				case "go-archive": {
					const folder = {
						"go-inbox": "inbox",
						"go-sent": "sent",
						"go-drafts": "draft",
						"go-archive": "archive",
					}[resolution.command];
					if (mailboxId) navigate(`/mailbox/${mailboxId}/emails/${folder}`);
					return;
				}
				default:
					publish(resolution.command);
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			resetPrefix();
		};
	}, [
		closePanel,
		isComposing,
		mailboxId,
		navigate,
		selectedEmailId,
		showShortcuts,
		startCompose,
	]);

	return (
		<Dialog.Root open={showShortcuts} onOpenChange={setShowShortcuts}>
			<Dialog size="lg" className="min-w-0 max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto p-0 sm:min-w-[32rem] sm:w-auto">
				<div className="flex items-center justify-between gap-3 border-b border-kumo-line px-4 py-4 sm:px-6 sm:py-5">
					<div className="flex min-w-0 items-center gap-3">
						<div className="shrink-0 rounded-lg bg-kumo-fill p-2 text-kumo-strong">
							<KeyboardIcon size={22} />
						</div>
						<div className="min-w-0">
							<Dialog.Title className="text-base font-semibold text-kumo-default">
								Keyboard shortcuts
							</Dialog.Title>
							<p className="mt-0.5 text-sm text-kumo-subtle">
								Move through mail without leaving the keyboard.
							</p>
						</div>
					</div>
					<Dialog.Close
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								icon={<XIcon size={18} />}
								aria-label="Close keyboard shortcuts"
							/>
						)}
					/>
				</div>
				<div className="grid gap-6 px-4 py-5 sm:grid-cols-3 sm:px-6">
					{SHORTCUT_GROUPS.map((group) => (
						<section key={group.label}>
							<h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
								{group.label}
							</h2>
							<dl className="space-y-2.5">
								{group.items.map(([keys, label]) => (
									<div key={keys} className="flex items-center justify-between gap-3">
										<dt className="text-sm text-kumo-strong">{label}</dt>
										<dd>
											<kbd className="whitespace-nowrap rounded border border-kumo-line bg-kumo-recessed px-1.5 py-0.5 font-mono text-[11px] font-semibold text-kumo-default shadow-sm">
												{keys}
											</kbd>
										</dd>
									</div>
								))}
							</dl>
						</section>
					))}
				</div>
				<div className="flex justify-end border-t border-kumo-line px-4 py-4 sm:px-6">
					<Button variant="secondary" onClick={() => setShowShortcuts(false)}>
						Close
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
