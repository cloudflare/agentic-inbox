// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// The editor schema's half of the marked-block round trip, exercised through
// the real parse rules and renderHTML rather than a copy of them. The live
// browser half is scripts/verify-polish-journey-playwright.mjs (03b).

import assert from "node:assert/strict";
import test from "node:test";
import { getSchema } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { joinBackward, joinForward } from "@tiptap/pm/commands";
import { MailMarkedBlock } from "./MailMarkedBlock.ts";
import {
	buildInitialComposeFields,
} from "../lib/compose-initialization.ts";
import {
	FORWARDED_MESSAGE_ATTRIBUTE,
	MAIL_BLOCK_VERSION,
	MAIL_SIGNATURE_ATTRIBUTE,
	QUOTED_REPLY_ATTRIBUTE,
} from "../lib/compose-signature.ts";

/** The slice of an element the parse rules actually read. */
function element(tag: string, attributes: Record<string, string>) {
	return {
		tagName: tag.toUpperCase(),
		getAttribute: (name: string) => attributes[name] ?? null,
	} as unknown as HTMLElement;
}

const rules = MailMarkedBlock.config.parseHTML!.call(
	{ name: MailMarkedBlock.name } as never,
) as Array<{
	tag: string;
	priority?: number;
	getAttrs: (element: HTMLElement) => Record<string, unknown> | false;
}>;

function ruleFor(tag: string) {
	const rule = rules.find((candidate) => candidate.tag === tag);
	assert.ok(rule, `no parse rule for ${tag}`);
	return rule;
}

function render(attrs: Record<string, unknown>) {
	return MailMarkedBlock.config.renderHTML!.call(
		{ name: MailMarkedBlock.name, options: {} } as never,
		{
			node: { attrs } as never,
			HTMLAttributes: attrs.style ? { style: attrs.style } : {},
		},
	) as [string, Record<string, string>, number];
}

test("every marked block compose seeds has a parse rule on its own tag", () => {
	assert.deepEqual(
		rules.map((rule) => rule.tag).sort(),
		[
			`blockquote[${QUOTED_REPLY_ATTRIBUTE}]`,
			`div[${FORWARDED_MESSAGE_ATTRIBUTE}]`,
			`div[${MAIL_SIGNATURE_ATTRIBUTE}]`,
		].sort(),
	);
});

test("marked quotes outrank StarterKit's bare blockquote rule", () => {
	// ProseMirror sorts parse rules by priority and defaults to 50, so an equal
	// priority would let a plain <blockquote> rule claim the marked quote first
	// and drop the marker with it.
	for (const rule of rules) {
		assert.ok(
			(rule.priority ?? 50) > 50,
			`${rule.tag} must outrank the default-priority rules`,
		);
	}
});

test("a marked block keeps its marker and its styling across a round trip", () => {
	for (const [attribute, tag] of [
		[QUOTED_REPLY_ATTRIBUTE, "blockquote"],
		[FORWARDED_MESSAGE_ATTRIBUTE, "div"],
		[MAIL_SIGNATURE_ATTRIBUTE, "div"],
	] as const) {
		const style = "border-left: 2px solid #ccc; color: #666;";
		const parsed = ruleFor(`${tag}[${attribute}]`).getAttrs(
			element(tag, { [attribute]: MAIL_BLOCK_VERSION, style }),
		);
		assert.deepEqual(parsed, { marker: attribute });

		const [renderedTag, renderedAttributes] = render({
			marker: attribute,
			style,
		});
		assert.equal(renderedTag, tag);
		assert.equal(renderedAttributes[attribute], MAIL_BLOCK_VERSION);
		assert.equal(renderedAttributes.style, style);
	}
});

test("an unmarked or wrongly versioned block is left to the ordinary nodes", () => {
	assert.equal(
		ruleFor(`blockquote[${QUOTED_REPLY_ATTRIBUTE}]`).getAttrs(
			element("blockquote", {}),
		),
		false,
	);
	assert.equal(
		ruleFor(`blockquote[${QUOTED_REPLY_ATTRIBUTE}]`).getAttrs(
			element("blockquote", { [QUOTED_REPLY_ATTRIBUTE]: "v2" }),
		),
		false,
	);
});

test("a block with no style renders no empty style attribute", () => {
	const [, attributes] = render({ marker: MAIL_SIGNATURE_ATTRIBUTE, style: null });
	assert.equal("style" in attributes, false);
	assert.equal(attributes[MAIL_SIGNATURE_ATTRIBUTE], MAIL_BLOCK_VERSION);
});

test("the schema covers the exact markers the compose bodies write", () => {
	const original = {
		id: "m1",
		sender: "grace@partner.example",
		recipient: "me@example.com",
		subject: "Quarterly launch decision",
		body: "<p>Agreed, let us lock the launch.</p>",
		date: "2026-07-23T12:00:00.000Z",
	};
	const seeded = [
		buildInitialComposeFields({
			composeOptions: { mode: "reply", originalEmail: original },
			signature: { enabled: true, text: "Hesham" },
		}).body,
		buildInitialComposeFields({
			composeOptions: { mode: "forward", originalEmail: original },
			signature: { enabled: true, text: "Hesham" },
		}).body,
	].join("");

	// Everything compose writes today must have a rule, or the editor drops it.
	for (const attribute of [FORWARDED_MESSAGE_ATTRIBUTE, MAIL_SIGNATURE_ATTRIBUTE]) {
		assert.ok(
			seeded.includes(`${attribute}="${MAIL_BLOCK_VERSION}"`),
			`compose no longer writes ${attribute}; retire its rule deliberately`,
		);
		assert.ok(
			rules.some((rule) => rule.tag.includes(`[${attribute}]`)),
			`${attribute} is written into compose bodies but the editor would drop it`,
		);
	}

	// Replies stopped quoting the message they answer, so nothing writes this
	// marker any more. The rule stays regardless: drafts persisted before that
	// change still carry a quote block, and losing the rule would strip its
	// marker and styling the first time the reader edits one.
	assert.ok(
		!seeded.includes(`${QUOTED_REPLY_ATTRIBUTE}=`),
		"replies must not seed a quoted original",
	);
	assert.ok(
		rules.some((rule) => rule.tag.includes(`[${QUOTED_REPLY_ATTRIBUTE}]`)),
		"older drafts still contain quote blocks and must survive an edit",
	);
});

// ── Editing the boundary ──────────────────────────────────────────────
//
// Schema-level assertions above cannot see what a keystroke does. These build
// the real ProseMirror schema and run the very commands TipTap binds, which
// needs no DOM: only EditorView does.

const schema = getSchema([StarterKit, MailMarkedBlock]);

function documentWithBlock(marker = MAIL_SIGNATURE_ATTRIBUTE) {
	return schema.node("doc", null, [
		schema.node("paragraph", null, [schema.text("My reply")]),
		schema.nodes.mailMarkedBlock.create(
			{ marker, style: "color: #666;" },
			[schema.node("paragraph", null, [schema.text("Hesham")])],
		),
		schema.node("paragraph", null, [schema.text("after")]),
	]);
}

function markedBlocks(doc: import("@tiptap/pm/model").Node) {
	const found: string[] = [];
	doc.descendants((node) => {
		if (node.type.name === "mailMarkedBlock") found.push(node.attrs.marker);
	});
	return found;
}

function runAt(position: number, command: typeof joinBackward) {
	let state = EditorState.create({ doc: documentWithBlock(), schema });
	state = state.apply(
		state.tr.setSelection(TextSelection.create(state.doc, position)),
	);
	command(state, (tr) => {
		state = state.apply(tr);
	});
	return state;
}

/** Offset of the first text position inside the marked block. */
const insideBlockStart = documentWithBlock().child(0).nodeSize + 2;

test("Backspace at the block's first character cannot dissolve the wrapper", () => {
	// TipTap's Keymap routes Backspace to joinBackward, and ProseMirror's
	// deleteBarrier honours `isolating` alone - `defining` does not stop it. One
	// Backspace here used to unwrap the block, taking the marker and the style
	// with it and leaving compose-signature unable to find the block again.
	const state = runAt(insideBlockStart, joinBackward);
	assert.deepEqual(markedBlocks(state.doc), [MAIL_SIGNATURE_ATTRIBUTE]);
	assert.equal(schema.nodes.mailMarkedBlock.spec.isolating, true);
});

test("forward Delete at the block's last character cannot dissolve it either", () => {
	// The mirror image of the same barrier, which joinForward also routes through.
	const doc = documentWithBlock();
	const blockEnd = doc.child(0).nodeSize + doc.child(1).nodeSize - 2;
	const state = runAt(blockEnd, joinForward);
	assert.deepEqual(markedBlocks(state.doc), [MAIL_SIGNATURE_ATTRIBUTE]);
});

test("the reader can still select the whole block and delete it outright", () => {
	// Isolating protects the boundary, not the block: an explicit selection over
	// it must still remove it, or the quote becomes impossible to get rid of.
	let state = EditorState.create({ doc: documentWithBlock(), schema });
	state = state.apply(
		state.tr.setSelection(
			NodeSelection.create(state.doc, state.doc.child(0).nodeSize),
		),
	);
	state = state.apply(state.tr.deleteSelection());
	assert.deepEqual(markedBlocks(state.doc), []);
});

test("a caret can still be placed in the paragraph after a marked block", () => {
	// Gapcursor ships with StarterKit, but the block is followed by a real
	// paragraph here: plain text positions after it must stay reachable.
	const doc = documentWithBlock();
	const afterBlock = doc.child(0).nodeSize + doc.child(1).nodeSize + 1;
	const selection = TextSelection.create(doc, afterBlock);
	assert.equal(selection.$from.parent.type.name, "paragraph");
	assert.equal(selection.$from.parent.textContent, "after");
});
