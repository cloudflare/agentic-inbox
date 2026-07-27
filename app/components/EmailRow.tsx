import { PaperclipIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { formatSenderLabel } from "~/lib/mail-participants";
import { formatDetailDate, formatListDate, getSnippetText, toIsoDate } from "~/lib/utils";
import type { Email } from "~/types";

/** Characters of snippet a row shows before its own truncation takes over. */
const SNIPPET_LENGTH = 120;

const identity = (text: string): ReactNode => text;

/**
 * The one conversation row, shared by the folder list, search results and
 * saved views so all three read identically.
 *
 * Three lines, each with its own truncation boundary: sender, subject, snippet.
 * Sharing one boundary is what previously made the snippet unreachable and let
 * the sender collapse to a few characters.
 *
 * Trailing actions are revealed on hover only where hovering exists. The gate is
 * pointer type, not viewport width: a large touch screen has no hover, so
 * `pointer-coarse` keeps the actions permanently visible there. Keyboard users
 * reach the same actions through the mail shortcuts.
 */
export default function EmailRow({
	email,
	unread,
	selected,
	onOpen,
	compact = false,
	dense = false,
	batchSelected = false,
	keyboardTarget = false,
	highlight = identity,
	select,
	star,
	meta,
	subjectMeta,
	footer,
	staticActions,
	actions,
}: {
	email: Email;
	unread: boolean;
	/** Open in the reading panel. Distinct from `batchSelected`. */
	selected: boolean;
	onOpen: () => void;
	compact?: boolean;
	/** Reading panel is open, so the list has less room. */
	dense?: boolean;
	batchSelected?: boolean;
	keyboardTarget?: boolean;
	highlight?: (text: string) => ReactNode;
	select?: ReactNode;
	star?: ReactNode;
	meta?: ReactNode;
	subjectMeta?: ReactNode;
	footer?: ReactNode;
	staticActions?: ReactNode;
	actions?: ReactNode;
}) {
	const sender = formatSenderLabel(email);
	const snippet = getSnippetText(email.snippet, SNIPPET_LENGTH);
	const threadCount = email.thread_count ?? 1;

	const state = selected
		? "bg-kumo-fill border-s-kumo-brand"
		: batchSelected
			? "bg-kumo-brand/10 border-s-kumo-brand/40"
			: "border-s-transparent hover:bg-kumo-tint";

	return (
		<div
			data-email-id={email.id}
			role="listitem"
			className={`group relative flex w-full min-w-0 items-center gap-2 overflow-hidden border-b border-s-2 border-kumo-line px-2 text-left transition-colors sm:px-3 ${
				compact ? "py-1" : "py-2"
			} ${dense ? "md:px-3" : "md:px-4"} ${state} ${
				keyboardTarget ? "ring-2 ring-inset ring-kumo-brand/50" : ""
			}`}
		>
			{select && <span className="flex shrink-0 items-center">{select}</span>}
			{star && <span className="flex shrink-0 items-center">{star}</span>}

			<button
				type="button"
				onClick={onOpen}
				aria-label={`Open conversation ${email.subject || "without subject"}`}
				className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
			>
				<span className="flex w-full items-center gap-2">
					{/* Width is reserved either way so read and unread senders align. */}
					<span className="flex w-2 shrink-0 justify-center" aria-hidden="true">
						{unread && <span className="h-2 w-2 rounded-full bg-kumo-brand" />}
					</span>
					<span
						title={sender.title}
						className={`min-w-16 flex-1 truncate text-sm ${
							unread ? "font-semibold text-kumo-default" : "text-kumo-strong"
						}`}
					>
						{highlight(sender.text)}
					</span>
					{threadCount > 1 && (
						<span className="shrink-0 rounded-full bg-kumo-fill px-1.5 py-0.5 text-xs font-medium text-kumo-subtle">
							{threadCount}
						</span>
					)}
					{meta}
					{email.has_attachments && (
						<PaperclipIcon
							size={13}
							className="shrink-0 text-kumo-subtle"
							aria-label="Has attachments"
						/>
					)}
					<time
						dateTime={toIsoDate(email.date)}
						title={formatDetailDate(email.date)}
						className="shrink-0 text-xs text-kumo-subtle"
					>
						{formatListDate(email.date)}
					</time>
				</span>

				<span className="flex w-full min-w-0 items-center gap-2">
					<span
						className={`min-w-0 truncate text-sm ${
							unread ? "font-medium text-kumo-default" : "text-kumo-subtle"
						}`}
					>
						{email.subject ? highlight(email.subject) : "(No subject)"}
					</span>
					{subjectMeta}
				</span>

				{!compact && snippet && (
					<span className="block w-full truncate text-xs text-kumo-subtle">
						{highlight(snippet)}
					</span>
				)}
				{footer}
			</button>

			{staticActions}
			{actions && (
				<div className="flex shrink-0 items-center pointer-fine:absolute pointer-fine:end-2 pointer-fine:top-1/2 pointer-fine:hidden pointer-fine:-translate-y-1/2 pointer-fine:rounded-md pointer-fine:bg-inherit pointer-fine:shadow-sm pointer-fine:group-hover:flex pointer-fine:group-focus-within:flex">
					{actions}
				</div>
			)}
		</div>
	);
}
