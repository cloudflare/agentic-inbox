import assert from "node:assert/strict";
import test from "node:test";
import type { Email } from "../types.ts";
import { composeSurface } from "./compose-surface.ts";

const original = { id: "email-1" } as Email;

test("answering a thread composes inside that thread", () => {
	for (const mode of ["reply", "reply-all", "forward"] as const) {
		assert.equal(
			composeSurface({ mode, originalEmail: original }, "email-1"),
			"inline",
			`${mode} should compose inline`,
		);
	}
});

test("new mail always uses the modal, even from an open thread", () => {
	assert.equal(
		composeSurface({ mode: "new", originalEmail: null }, "email-1"),
		"modal",
	);
	assert.equal(
		composeSurface({ mode: "new", initialTo: "a@example.com" }, "email-1"),
		"modal",
	);
});

test("a reply with no thread on screen falls back to the modal", () => {
	// The agent panel opens a draft reply with no anchor message, and nothing
	// hosts an inline card when no conversation is selected.
	assert.equal(
		composeSurface({ mode: "reply", originalEmail: null }, "email-1"),
		"modal",
	);
	assert.equal(
		composeSurface({ mode: "reply", originalEmail: original }, null),
		"modal",
	);
});

test("editing a stored draft reply still composes in its thread", () => {
	assert.equal(
		composeSurface(
			{
				mode: "reply",
				originalEmail: original,
				draftEmail: { id: "draft-1" } as Email,
			},
			"email-1",
		),
		"inline",
	);
});
