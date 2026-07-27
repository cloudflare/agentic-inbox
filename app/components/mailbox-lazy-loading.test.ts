import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("the rich composer is loaded only when compose is open", () => {
	const mailbox = read("../routes/mailbox.tsx");

	assert.match(
		mailbox,
		/useMemo\([\s\S]*?lazy\(\(\) => import\("~\/components\/ComposeEmail"\)\)[\s\S]*?\[composeRetryKey\]/,
	);
	assert.doesNotMatch(mailbox, /import ComposeEmail from/);
	assert.match(
		mailbox,
		/isComposing \? \([\s\S]*?<Suspense[\s\S]*?<ComposeEmail \/>/,
	);
	assert.match(mailbox, /role="status"/);
	assert.match(
		mailbox,
		/ComposeLoadingFallback[\s\S]*?onCancel=\{closeCompose\}/,
	);
	assert.match(mailbox, /ComposeLoadError[\s\S]*?onClose=\{closeCompose\}/);
	assert.match(mailbox, /event\.key === "Escape"/);
	assert.match(mailbox, /confirmDiscardPendingCompose/);
	assert.match(mailbox, /Retry composer/);
	assert.match(mailbox, /composeRetryKey/);
	assert.match(mailbox, /onRetry=\{\(\) => setComposeRetryKey/);
});

test("the composer is reached through exactly one import path", () => {
	const panel = read("./EmailPanel.tsx");
	const compose = read("./ComposeEmail.tsx");

	// A second import site makes the editor's dependencies reachable only through
	// a nested dynamic import, which re-optimizes them into a second React copy
	// at runtime and crashes the editor with an invalid hook call. The thread
	// offers a host node instead, and the one mounted composer portals into it.
	assert.doesNotMatch(panel, /import\("~\/components\/ComposeEmail"\)/);
	assert.doesNotMatch(panel, /import ComposeEmail from/);
	assert.match(panel, /<div id=\{INLINE_COMPOSE_HOST_ID\} \/>/);
	assert.match(compose, /createPortal\(/);
	assert.match(
		compose,
		/document\.getElementById\(INLINE_COMPOSE_HOST_ID\)/,
	);
});

test("the optional writing assistant is deferred behind a retryable local boundary", () => {
	const compose = read("./ComposeEmail.tsx");
	const assistant = read("./ComposeAiAssistant.tsx");

	assert.match(
		compose,
		/useMemo\([\s\S]*?lazy\(\(\) => import\("\.\/ComposeAiAssistant"\)\)[\s\S]*?\[aiPanelRetryKey\]/,
	);
	assert.doesNotMatch(compose, /import ComposeAiAssistant from/);
	assert.doesNotMatch(compose, /useAiDraftCompose/);
	assert.match(
		compose,
		/<LazyLoadBoundary[\s\S]*?<Suspense[\s\S]*?<ComposeAiAssistant/,
	);
	assert.match(compose, /Opening writing assistant…/);
	assert.match(
		compose,
		/Writing assistant could not open\. Your draft is[\s\S]*?unchanged\./,
	);
	assert.match(compose, /setAiPanelRetryKey\(\(key\) => key \+ 1\)/);
	assert.match(assistant, /useAiDraftCompose\(\)/);
	assert.match(assistant, /validateAiComposeDraftRequest/);
	assert.match(assistant, /hasComposeSignature/);
});

test("conversation detail is loaded only after a message is selected", () => {
	const split = read("./MailboxSplitView.tsx");

	assert.match(split, /lazy\(\(\) => import\("~\/components\/EmailPanel"\)\)/);
	assert.doesNotMatch(split, /import EmailPanel from/);
	assert.match(
		split,
		/isPanelOpen && selectedEmailId && \([\s\S]*?<Suspense[\s\S]*?<EmailPanel emailId=\{selectedEmailId\}/,
	);
	assert.match(split, /aria-label="Opening conversation"/);
	assert.match(split, /EmailPanelLoadingFallback onBack=\{closePanel\}/);
	assert.match(split, /EmailPanelLoadError onBack=\{closePanel\}/);
	assert.match(split, /Back to messages/);
});

test("deferred feature failures stay inside a resettable local boundary", () => {
	const boundary = read("./LazyLoadBoundary.tsx");

	assert.match(boundary, /getDerivedStateFromError/);
	assert.match(boundary, /previousProps\.resetKey !== this\.props\.resetKey/);
	assert.match(boundary, /this\.state\.hasError \? this\.props\.fallback/);
});
