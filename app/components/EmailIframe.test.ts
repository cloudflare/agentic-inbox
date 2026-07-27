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
	// Opted-in image loads must not carry the portal URL to the sender's host.
	assert.match(source, /<meta name="referrer" content="no-referrer">/);
});

test("a blocked image leaves no glyph, box, or rewritten alt behind", () => {
	assert.match(source, /img\[data-remote-image-blocked\],/);
	// An image stripped down to no source at all must not show a glyph either,
	// while one still awaiting its inline-image blob stays visible.
	// ...unless a sibling <picture> source the reader opted into still draws it.
	assert.match(
		source,
		/img:not\(\[src\]\):not\(\[srcset\]\):not\(\[data-email-inline-cid\]\):not\(\[data-remote-image-drawn\]\) \{ display: none; \}/,
	);
	// Overwriting the author's alt was what put "Remote image blocked for
	// privacy" text where the picture should be; the banner says it instead.
	assert.doesNotMatch(source, /Remote image blocked for privacy/);
	assert.doesNotMatch(source, /image\.setAttribute\(\s*"alt"/);
});

test("only images the reader can actually reveal offer the opt-in", () => {
	// https: and protocol-relative resolve under the opt-in CSP, so they are
	// blocked-but-recoverable and drive the banner.
	assert.match(source, /if \(\/\^https:\\\/\\\/\/i\.test\(source\) \|\| source\.startsWith\("\/\/"\)\) return "loadable";/);
	// http: and relative srcs can never load; they stay stripped in both states
	// instead of turning into broken images the "Load images" button can't fix.
	assert.match(source, /return "unloadable";/);
	assert.match(
		source,
		/sourceKind === "unloadable" \|\|\s*\(sourceKind === "loadable" && !loadRemoteImages\)/,
	);
	// `<img src="/fallback.png" srcset="https://cdn/hero.png 1x">`: the src can
	// never load, the srcset can. Marking it blocked anyway offered "Load
	// images" and then kept the image hidden with a live srcset attached.
	assert.match(source, /const drawnBySourceSet = remoteSourceSet && loadRemoteImages;/);
	assert.match(
		source,
		/image\.removeAttribute\("src"\);\s*if \(!drawnBySourceSet\) \{\s*image\.setAttribute\("data-remote-image-blocked", "true"\);/,
	);
	// Blocked state is untouched: `drawnBySourceSet` can only be true under the
	// opt-in, and the srcset is still stripped whenever the reader has not.
	assert.match(source, /if \(remoteSourceSet && !loadRemoteImages\) \{\s*image\.removeAttribute\("srcset"\);/);
	// `<picture><source srcset="https://…"><img src="/fallback.png"></picture>`
	// is the same defect one level out: the surviving candidate is a sibling the
	// <img> walk runs too early to see, so the <source> walk clears the mark.
	assert.match(
		source,
		/\} else if \(remoteSourceSet\) \{[\s\S]*?const drawn = picture\?\.querySelector\("img"\);[\s\S]*?drawn\.removeAttribute\("data-remote-image-blocked"\);[\s\S]*?drawn\.setAttribute\("data-remote-image-drawn", "true"\);/,
	);
	// Only ever reached under the opt-in: the branch above claims every
	// remote-srcset source while loadRemoteImages is false.
	assert.match(
		source,
		/if \(cidOwned \|\| \(remoteSourceSet && !loadRemoteImages\)\) \{\s*source\.removeAttribute\("srcset"\);/,
	);
	assert.match(source, /if \(sourceKind === "loadable" \|\| remoteSourceSet\)/);
	assert.match(source, /setHasRemoteImages\(togglesRemoteImages\)/);
	// The banner must come from the sanitize walk, never a second regex over
	// the raw body that can disagree with what was actually stripped.
	assert.doesNotMatch(source, /useMemo/);
	assert.doesNotMatch(source, /test\(body\)/);
	// Protocol-relative candidates are remote too, in srcset as well as src.
	assert.match(source, /\(\?:\^\|,\)\\s\*\(\?:https\?:\)\?\\\/\\\//);
});

test("the frame follows its content instead of a fixed report schedule", () => {
	assert.match(source, /new ResizeObserver/);
	assert.match(source, /heightObserver\.observe\(document\.documentElement\)/);
	assert.match(source, /heightObserver\.observe\(document\.body\)/);
	assert.match(source, /document\.images\[loadIndex\]\.addEventListener\("load", reportHeight\)/);
	assert.match(source, /document\.images\[loadIndex\]\.addEventListener\("error", reportHeight\)/);
	assert.match(source, /window\.addEventListener\("load", reportHeight\)/);
	// The timer ladder is gone; one fallback remains for engines that never
	// deliver a resize record.
	assert.doesNotMatch(source, /setTimeout\(reportHeight, 50\)/);
	assert.doesNotMatch(source, /setTimeout\(reportHeight, 150\)/);
	assert.match(source, /setTimeout\(reportHeight, 400\)/);
	// Height still crosses the bridge on the same nonce-bound contract.
	assert.match(source, /__emailIframeHeight: true, nonce: nonce, height: height/);
});

test("the privacy banner never remounts the iframe it sits above", () => {
	assert.doesNotMatch(source, /if \(!hasRemoteImages\) return frame;/);
	assert.match(source, /\{hasRemoteImages && \(/);
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
