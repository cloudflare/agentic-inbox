import type { ComposeOptions } from "../hooks/useUIStore.ts";

export type ComposeSurface = "modal" | "inline";

/**
 * The element an open thread offers as the home for an inline composer. The
 * composer stays a single mounted instance and renders into this node, so the
 * editor is never loaded through a second module path.
 */
export const INLINE_COMPOSE_HOST_ID = "inline-compose-host";

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
