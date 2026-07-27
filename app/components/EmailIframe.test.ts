import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
	new URL("./EmailIframe.tsx", import.meta.url),
	"utf8",
);

test("remote email images require explicit per-message consent", () => {
	assert.match(source, /messageId:\s*string/);
	assert.match(source, /remoteImagesForMessageId === messageId/);
	assert.doesNotMatch(source, /remoteImagesForBody === body/);
	assert.match(source, /image\.removeAttribute\("src"\)/);
	assert.match(source, /Remote images are blocked to protect your privacy/);
	assert.match(source, /loadRemoteImages \? " https:" : ""/);
});

test("every email renderer passes explicit message identity", () => {
	const renderer = readFileSync(
		new URL("./email-panel/ThreadMessage.tsx", import.meta.url),
		"utf8",
	);
	assert.match(renderer, /<EmailMessageBody[\s\S]*?email=\{email\}/);
	const sharedRenderer = readFileSync(
		new URL("./email-panel/EmailMessageBody.tsx", import.meta.url),
		"utf8",
	);
	assert.match(sharedRenderer, /<EmailIframe[\s\S]*?messageId=\{email\.id\}/);
});

test("inline CID bytes cross only the nonce-bound opaque iframe bridge", () => {
	assert.match(source, /api\.getAttachment\([\s\S]*?mailboxId,[\s\S]*?messageId,[\s\S]*?planned\.attachmentId,[\s\S]*?signal/);
	assert.match(source, /event\.source !== frameWindow/);
	assert.match(source, /event\.data\.nonce !== nonce/);
	assert.match(source, /crypto\.randomUUID\(\)/);
	assert.match(source, /URL\.revokeObjectURL/);
	assert.match(source, /payloadAccepted/);
	assert.match(source, /expectedManifest/);
	assert.match(source, /payload\.blob\.size/);
	assert.match(source, /image\.removeAttribute\("src"\)/);
	assert.match(source, /data-email-inline-cid/);
	assert.match(source, /img-src data: blob:/);
	assert.doesNotMatch(source, /img-src data: cid:/);
	const sandbox = source.match(/sandbox="([^"]+)"/)?.[1];
	assert.ok(sandbox);
	assert.equal(sandbox.includes("allow-same-origin"), false);
	assert.doesNotMatch(source, /attachments\/\$\{.*attachmentId/);
});

test("a new render clears private content before parsing hostile metadata", () => {
	const clearIndex = source.indexOf("iframe.srcdoc = EMPTY_EMAIL_IFRAME_DOCUMENT");
	const sanitizeIndex = source.indexOf("DOMPurify.sanitize(body");
	const planIndex = source.indexOf("planReferencedInlineImages(");
	assert.ok(clearIndex > 0);
	assert.ok(clearIndex < sanitizeIndex);
	assert.ok(clearIndex < planIndex);
});

test("CID rendering neutralizes responsive candidates before remote opt-in", () => {
	assert.match(source, /image\.removeAttribute\("srcset"\)/);
	assert.match(source, /source\.removeAttribute\("srcset"\)/);
	assert.match(source, /cidPictures/);
});
