import type { ComposeOptions } from "../hooks/useUIStore.ts";

export type ComposeSurface = "modal" | "inline";

/**
 * Replies, reply-alls and forwards compose inline at the end of the thread they
 * answer, so the conversation stays readable while writing. Everything else,
 * including a reply with no thread on screen to host it, uses the modal.
 */
export function composeSurface(
	options: ComposeOptions,
	selectedEmailId: string | null,
): ComposeSurface {
	return options.mode !== "new" &&
		Boolean(options.originalEmail?.id) &&
		selectedEmailId !== null
		? "inline"
		: "modal";
}
