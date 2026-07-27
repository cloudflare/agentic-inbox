// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { mergeAttributes, Node } from "@tiptap/react";
import {
	FORWARDED_MESSAGE_ATTRIBUTE,
	MAIL_BLOCK_VERSION,
	MAIL_SIGNATURE_ATTRIBUTE,
	QUOTED_REPLY_ATTRIBUTE,
} from "../lib/compose-signature.ts";

/**
 * Which element each marked block is written as by the compose body builders.
 * The tag is part of the contract: `compose-signature` matches the quoted tail
 * on `<div|blockquote ... data-mail-*>`, and the reply quote is styled as a
 * blockquote in both the editor and the sent mail.
 */
const TAG_BY_MARKER: Readonly<Record<string, "blockquote" | "div">> = {
	[QUOTED_REPLY_ATTRIBUTE]: "blockquote",
	[FORWARDED_MESSAGE_ATTRIBUTE]: "div",
	[MAIL_SIGNATURE_ATTRIBUTE]: "div",
};

/**
 * The three blocks compose seeds and then navigates by: the quoted reply, the
 * forwarded original and the signature.
 *
 * Without this node the editor loses all three the moment the user types.
 * StarterKit has no `div` node at all, so the forwarded and signature blocks are
 * unwrapped and their contents flattened into the body; its blockquote declares
 * no attributes, so the reply marker and the quote styling are dropped on the
 * first serialize. That breaks signature placement, AI-rewrite boundaries
 * (`compose-signature.ts`) and the visual quote styling of sent mail alike.
 */
export const MailMarkedBlock = Node.create({
	name: "mailMarkedBlock",
	group: "block",
	content: "block+",
	defining: true,

	addAttributes() {
		return {
			// Rendered by hand below so the marker keeps its own attribute name.
			marker: { default: null, rendered: false },
			style: {
				default: null,
				parseHTML: (element) => element.getAttribute("style"),
				renderHTML: (attributes) =>
					attributes.style ? { style: attributes.style } : {},
			},
		};
	},

	parseHTML() {
		// Ahead of StarterKit's bare `blockquote` rule, which ProseMirror gives the
		// default priority of 50: a marked quote must keep its identity rather than
		// collapse into an ordinary blockquote.
		return Object.entries(TAG_BY_MARKER).map(([marker, tag]) => ({
			tag: `${tag}[${marker}]`,
			priority: 60,
			getAttrs: (element: HTMLElement) =>
				element.getAttribute(marker) === MAIL_BLOCK_VERSION ? { marker } : false,
		}));
	},

	renderHTML({ node, HTMLAttributes }) {
		const marker: string | null = node.attrs.marker;
		const tag = marker ? TAG_BY_MARKER[marker] : undefined;
		if (!marker || !tag) return ["div", mergeAttributes(HTMLAttributes), 0];
		return [
			tag,
			mergeAttributes(HTMLAttributes, { [marker]: MAIL_BLOCK_VERSION }),
			0,
		];
	},
});
