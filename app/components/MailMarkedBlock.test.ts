// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// The editor schema's half of the marked-block round trip, exercised through
// the real parse rules and renderHTML rather than a copy of them. The live
// browser half is scripts/verify-polish-journey-playwright.mjs (03b).

import assert from "node:assert/strict";
import test from "node:test";
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

	for (const rule of rules) {
		const attribute = rule.tag.slice(rule.tag.indexOf("[") + 1, -1);
		assert.ok(
			seeded.includes(`${attribute}="${MAIL_BLOCK_VERSION}"`),
			`compose never writes ${attribute}, so the schema rule is dead`,
		);
	}
	// And nothing compose writes is missing a rule.
	for (const attribute of [
		QUOTED_REPLY_ATTRIBUTE,
		FORWARDED_MESSAGE_ATTRIBUTE,
		MAIL_SIGNATURE_ATTRIBUTE,
	]) {
		assert.ok(
			rules.some((rule) => rule.tag.includes(`[${attribute}]`)),
			`${attribute} is written into compose bodies but the editor would drop it`,
		);
	}
});
