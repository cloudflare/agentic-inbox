// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import {
	isExpectedInlineImageBlob,
	normalizeInlineContentId,
	planReferencedInlineImages,
	type PlannedInlineImage,
} from "~/lib/email-inline-images";
import api from "~/services/api";
import type { Attachment } from "~/types";

// Force every link in rendered email HTML to open in a new tab. Email anchors
// usually carry no `target`, so inside the sandboxed iframe a click would
// navigate the iframe's own browsing context — replacing the email with the
// linked page. Stamp target + rel on every <a> so links escape the iframe.
// Registered once (module-scoped flag) and only on the client, since the hook
// touches the DOM.
let linkTargetHookRegistered = false;
function ensureLinkTargetHook() {
	if (linkTargetHookRegistered) return;
	linkTargetHookRegistered = true;
	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		if (node.nodeName === "A") {
			node.setAttribute("target", "_blank");
			node.setAttribute("rel", "noopener noreferrer");
		}
	});
}

interface EmailIframeProps {
	messageId: string;
	body: string;
	mailboxId?: string;
	inlineAttachments?: Attachment[];
	/** When true, iframe auto-sizes to content height instead of filling parent */
	autoSize?: boolean;
}

type InlineImagePayload = {
	cid: string;
	blob: Blob;
};

const INLINE_IMAGE_DOWNLOAD_CONCURRENCY = 4;
const EMPTY_EMAIL_IFRAME_DOCUMENT = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';">
</head>
<body></body>
</html>`;

function sourceSetContainsCid(value: string): boolean {
	return /(?:^|,)\s*cid:/i.test(value);
}

function sourceSetContainsRemoteImage(value: string): boolean {
	return /(?:^|,)\s*(?:https?:)?\/\//i.test(value);
}

/**
 * How the srcdoc document can treat an `<img src>`:
 * - `null` — nothing to do. `cid:` is served over the inline-image bridge,
 *   `data:`/`blob:` are already allowed by the CSP in both states.
 * - `"loadable"` — a remote source the opt-in CSP (`img-src data: blob: https:`)
 *   can actually fetch. Blocked until the reader opts in, then restored.
 * - `"unloadable"` — a source that can never render, whatever the reader picks.
 *   `http:` fails on the https-only opt-in CSP and on mixed content; a relative
 *   src resolves against the portal origin rather than the sender's site, so it
 *   can only 404. Both are stripped and hidden in BOTH states, otherwise they
 *   render as broken-image glyphs that opting in never fixes.
 */
function classifyImageSource(source: string): "loadable" | "unloadable" | null {
	if (!source || /^(?:cid|data|blob):/i.test(source)) return null;
	// Protocol-relative resolves against the https portal, so it is fetchable.
	if (/^https:\/\//i.test(source) || source.startsWith("//")) return "loadable";
	return "unloadable";
}

async function downloadInlineImages(
	plannedImages: readonly PlannedInlineImage[],
	mailboxId: string,
	messageId: string,
	signal: AbortSignal,
): Promise<InlineImagePayload[]> {
	const results: Array<InlineImagePayload | null> = Array.from(
		{ length: plannedImages.length },
		() => null,
	);
	let nextIndex = 0;
	async function worker() {
		while (!signal.aborted) {
			const index = nextIndex;
			nextIndex += 1;
			const planned = plannedImages[index];
			if (!planned) return;
			try {
				const blob = await api.getAttachment(
					mailboxId,
					messageId,
					planned.attachmentId,
					{ signal },
				);
				if (!signal.aborted && isExpectedInlineImageBlob(planned, blob)) {
					results[index] = { cid: planned.cid, blob };
				}
			} catch {
				// A failed inline image stays broken without affecting the message body.
			}
		}
	}
	await Promise.all(
		Array.from(
			{ length: Math.min(INLINE_IMAGE_DOWNLOAD_CONCURRENCY, plannedImages.length) },
			() => worker(),
		),
	);
	return results.filter((result): result is InlineImagePayload => result !== null);
}

function iframeBridgeScript(
	nonce: string,
	plannedImages: readonly PlannedInlineImage[],
): string {
	const expectedManifest = plannedImages.map((planned) => ({
		cid: planned.cid,
		mimeType: planned.expectedMimeType,
		size: planned.expectedSize,
	}));
	return `<script>
(function () {
	"use strict";
	var nonce = ${JSON.stringify(nonce)};
	var expectedManifest = ${JSON.stringify(expectedManifest)};
	var maximumImageCount = 32;
	var maximumAggregateBytes = 25 * 1024 * 1024;
	var activeObjectUrls = [];
	var inlineImageTargets = new Map();
	var payloadAccepted = false;
	var allowedMimeTypes = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
	function normalizeCid(value) {
		if (typeof value !== "string" || value.length > 512) return null;
		var normalized = value.trim();
		if (/^cid:/i.test(normalized)) normalized = normalized.slice(4).trim();
		if (normalized.startsWith("<") && normalized.endsWith(">")) {
			normalized = normalized.slice(1, -1).trim();
		}
		if (!normalized || new TextEncoder().encode(normalized).byteLength > 512 || /[\\u0000-\\u0020\\u007f<>]/.test(normalized)) return null;
		normalized = normalized.normalize("NFC").toLowerCase();
		return normalized.length <= 512 && new TextEncoder().encode(normalized).byteLength <= 512 ? normalized : null;
	}
	var manifestByCid = new Map();
	var manifestBytes = 0;
	var manifestValid = Array.isArray(expectedManifest) && expectedManifest.length <= maximumImageCount;
	if (manifestValid) {
		for (var manifestIndex = 0; manifestIndex < expectedManifest.length; manifestIndex += 1) {
			var expected = expectedManifest[manifestIndex];
			var expectedCid = expected && normalizeCid(expected.cid);
			var expectedMimeType = expected && typeof expected.mimeType === "string" ? expected.mimeType.trim().toLowerCase() : "";
			var expectedSize = expected && expected.size;
			if (!expectedCid || expectedCid !== expected.cid || !allowedMimeTypes.has(expectedMimeType) ||
				!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > maximumAggregateBytes ||
				manifestByCid.has(expectedCid) || manifestBytes + expectedSize > maximumAggregateBytes) {
				manifestValid = false;
				break;
			}
			manifestByCid.set(expectedCid, { mimeType: expectedMimeType, size: expectedSize });
			manifestBytes += expectedSize;
		}
	}
	if (!manifestValid) manifestByCid.clear();
	function reportHeight() {
		var height = Math.max(
			document.body.scrollHeight,
			document.documentElement.scrollHeight
		);
		if (height > 0) parent.postMessage({ __emailIframeHeight: true, nonce: nonce, height: height }, "*");
	}
	function revokeObjectUrls() {
		for (var index = 0; index < activeObjectUrls.length; index += 1) {
			URL.revokeObjectURL(activeObjectUrls[index]);
		}
		activeObjectUrls = [];
	}
	function matchingImages(cid) {
		var known = inlineImageTargets.get(cid) || [];
		known = known.filter(function (image) { return image.isConnected; });
		if (known.length > 0) return known;
		var matches = [];
		for (var imageIndex = 0; imageIndex < document.images.length; imageIndex += 1) {
			var image = document.images[imageIndex];
			if (normalizeCid(image.getAttribute("data-email-inline-cid") || image.getAttribute("src") || "") === cid) {
				matches.push(image);
			}
		}
		return matches;
	}
	window.addEventListener("message", function (event) {
		if (event.source !== parent) return;
		var data = event.data;
		if (payloadAccepted || !manifestValid || !data || typeof data !== "object" || data.__emailIframeInlineImages !== true || data.nonce !== nonce || !Array.isArray(data.images) || data.images.length > maximumImageCount) return;
		var preparedImages = [];
		var seenCids = new Set();
		var payloadBytes = 0;
		for (var payloadIndex = 0; payloadIndex < data.images.length; payloadIndex += 1) {
			var payload = data.images[payloadIndex];
			if (!payload || typeof payload !== "object" || !(payload.blob instanceof Blob)) return;
			var cid = normalizeCid(payload.cid);
			var mimeType = payload.blob.type.split(";", 1)[0].trim().toLowerCase();
			var expectedPayload = cid && manifestByCid.get(cid);
			if (!cid || seenCids.has(cid) || !expectedPayload || mimeType !== expectedPayload.mimeType ||
				payload.blob.size !== expectedPayload.size || payloadBytes + payload.blob.size > maximumAggregateBytes) return;
			var matches = matchingImages(cid);
			if (matches.length === 0) return;
			seenCids.add(cid);
			payloadBytes += payload.blob.size;
			preparedImages.push({ blob: payload.blob, cid: cid, matches: matches });
		}
		payloadAccepted = true;
		revokeObjectUrls();
		for (var preparedIndex = 0; preparedIndex < preparedImages.length; preparedIndex += 1) {
			var prepared = preparedImages[preparedIndex];
			var objectUrl = URL.createObjectURL(prepared.blob);
			activeObjectUrls.push(objectUrl);
			inlineImageTargets.set(prepared.cid, prepared.matches);
			for (var matchIndex = 0; matchIndex < prepared.matches.length; matchIndex += 1) {
				prepared.matches[matchIndex].removeAttribute("data-email-inline-cid");
				prepared.matches[matchIndex].addEventListener("load", reportHeight, { once: true });
				prepared.matches[matchIndex].addEventListener("error", reportHeight, { once: true });
				prepared.matches[matchIndex].src = objectUrl;
			}
		}
		reportHeight();
	});
	window.addEventListener("pagehide", revokeObjectUrls, { once: true });
	window.addEventListener("beforeunload", revokeObjectUrls, { once: true });
	// Remote images decode long after the document is parsed, and the parent
	// pins this frame's height while the body clips its own overflow — so a
	// height reported on a fixed schedule clips every image that arrives late.
	// Watch the document instead and report whenever it actually reflows.
	if (typeof ResizeObserver === "function") {
		var heightObserver = new ResizeObserver(function () { reportHeight(); });
		heightObserver.observe(document.documentElement);
		heightObserver.observe(document.body);
	}
	for (var loadIndex = 0; loadIndex < document.images.length; loadIndex += 1) {
		document.images[loadIndex].addEventListener("load", reportHeight);
		document.images[loadIndex].addEventListener("error", reportHeight);
	}
	window.addEventListener("load", reportHeight);
	parent.postMessage({ __emailIframeReady: true, nonce: nonce }, "*");
	reportHeight();
	setTimeout(reportHeight, 400);
})();
<\/script>`;
}

/**
 * Renders email HTML inside a sandboxed iframe.
 *
 * Security model:
 * - DOMPurify sanitises the HTML before injection.
 * - The iframe sandbox does NOT include `allow-same-origin`, so even if
 *   DOMPurify has a bypass the attacker's code runs in an opaque origin
 *   with no access to the parent page's cookies, DOM, or API.
 * - Because the iframe is cross-origin we cannot read `contentDocument`
 *   for auto-sizing. Instead, the injected HTML includes a tiny inline
 *   script that posts its body height to the parent via `postMessage`.
 *   The `allow-scripts` flag is required for this, but scripts inside
 *   the opaque-origin sandbox cannot access anything useful.
 * - A strict CSP meta tag blocks external resource loads inside the
 *   iframe as a defense-in-depth layer.
 * - `allow-popups-to-escape-sandbox` lets links the user clicks open as
 *   normal, full-origin tabs. Without it, popups inherit this iframe's
 *   sandbox (no `allow-same-origin` -> opaque "null" origin) and the
 *   destination app crashes reading cookies/localStorage. This flag only
 *   affects newly-opened tabs; the email body itself stays fully
 *   sandboxed with no same-origin access to the parent page.
 */
export default function EmailIframe({
	messageId,
	body,
	mailboxId,
	inlineAttachments,
	autoSize,
}: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);
	const [remoteImagesForMessageId, setRemoteImagesForMessageId] = useState<
		string | null
	>(null);
	const loadRemoteImages = remoteImagesForMessageId === messageId;
	const [hasRemoteImages, setHasRemoteImages] = useState(false);

	useEffect(() => {
		const iframe = iframeRef.current;
		const frameWindow = iframe?.contentWindow;
		if (!iframe || !frameWindow) return;

		iframe.srcdoc = EMPTY_EMAIL_IFRAME_DOCUMENT;
		ensureLinkTargetHook();
		const nonce = crypto.randomUUID();
		const controller = new AbortController();
		let iframeReady = false;
		let payloads: InlineImagePayload[] | null = null;
		let payloadPosted = false;

		let cleanBody = DOMPurify.sanitize(body, {
			USE_PROFILES: { html: true },
			FORBID_TAGS: ["style"],
			ADD_ATTR: ["target"],
			FORCE_BODY: true,
		});

		const template = document.createElement("template");
		template.innerHTML = cleanBody;
		const referencedCids: string[] = [];
		const cidPictures = new Set<Element>();
		// Set by the same walk that strips, so the privacy banner offers "Load
		// images" exactly when opting in would actually reveal something.
		let togglesRemoteImages = false;
		for (const image of template.content.querySelectorAll("img")) {
			image.removeAttribute("data-email-inline-cid");
			const source = image.getAttribute("src")?.trim() ?? "";
			const sourceSet = image.getAttribute("srcset") ?? "";
			const isCidSource = /^cid:/i.test(source);
			const normalizedCid = isCidSource
				? normalizeInlineContentId(source)
				: null;
			if (isCidSource) image.removeAttribute("src");
			if (normalizedCid) {
				referencedCids.push(source);
				image.setAttribute("data-email-inline-cid", normalizedCid);
				const picture = image.closest("picture");
				if (picture) cidPictures.add(picture);
			}
			const cidSourceSet = isCidSource || sourceSetContainsCid(sourceSet);
			if (cidSourceSet) image.removeAttribute("srcset");
			const remoteSourceSet =
				!cidSourceSet && sourceSetContainsRemoteImage(sourceSet);
			const sourceKind = classifyImageSource(source);
			if (sourceKind === "loadable" || remoteSourceSet) {
				togglesRemoteImages = true;
			}
			// An opted-in srcset still draws this image, so stripping an unloadable
			// src must not also mark it blocked - the stylesheet would hide a
			// picture the reader just asked for and "Load images" would do nothing.
			const drawnBySourceSet = remoteSourceSet && loadRemoteImages;
			if (
				sourceKind === "unloadable" ||
				(sourceKind === "loadable" && !loadRemoteImages)
			) {
				image.removeAttribute("src");
				if (!drawnBySourceSet) {
					image.setAttribute("data-remote-image-blocked", "true");
				}
			}
			if (remoteSourceSet && !loadRemoteImages) {
				image.removeAttribute("srcset");
			}
		}
		for (const source of template.content.querySelectorAll("source[srcset]")) {
			const sourceSet = source.getAttribute("srcset") ?? "";
			const picture = source.closest("picture");
			const cidOwned =
				(picture && cidPictures.has(picture)) || sourceSetContainsCid(sourceSet);
			const remoteSourceSet =
				!cidOwned && sourceSetContainsRemoteImage(sourceSet);
			if (remoteSourceSet) togglesRemoteImages = true;
			if (cidOwned || (remoteSourceSet && !loadRemoteImages)) {
				source.removeAttribute("srcset");
			}
		}
		setHasRemoteImages(togglesRemoteImages);
		cleanBody = template.innerHTML;
		const plannedImages = planReferencedInlineImages(
			referencedCids,
			inlineAttachments,
		);

		const padding = autoSize ? "0" : "24px";
		const postInlineImages = () => {
			if (
				payloadPosted ||
				!iframeReady ||
				payloads === null ||
				controller.signal.aborted
			) return;
			payloadPosted = true;
			frameWindow.postMessage({
				__emailIframeInlineImages: true,
				nonce,
				images: payloads,
			}, "*");
		};
		const handleMessage = (event: MessageEvent) => {
			if (event.source !== frameWindow) return;
			if (
				!event.data ||
				typeof event.data !== "object" ||
				event.data.nonce !== nonce
			) return;
			if (event.data.__emailIframeReady === true) {
				iframeReady = true;
				postInlineImages();
				return;
			}
			if (
				autoSize &&
				event.data.__emailIframeHeight === true &&
				typeof event.data.height === "number" &&
				Number.isFinite(event.data.height) &&
				event.data.height > 0 &&
				event.data.height <= 1_000_000
			) {
				setHeight(Math.ceil(event.data.height));
			}
		};
		window.addEventListener("message", handleMessage);

		// Use srcdoc so the iframe is truly sandboxed (no same-origin access).
		// We can't use doc.write() because that requires allow-same-origin.
		iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
<base target="_blank">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:${loadRemoteImages ? " https:" : ""}; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; }
html {
	background: #ffffff;
	color-scheme: light;
}
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	font-size: 14px;
	line-height: 1.6;
	color: #1a1a1a;
	background: #ffffff;
	padding: ${padding};
	margin: 0;
	word-wrap: break-word;
	overflow-wrap: break-word;
	${autoSize ? "overflow: hidden;" : ""}
}
[style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"], [style*="position:absolute"] {
	position: relative !important;
}
a { color: #2563eb; }
img { max-width: 100%; height: auto; }
/* An image whose source was stripped has nothing left to render, so hide it
   outright rather than leave a broken-image glyph or an alt-text box in the
   message. The second selector catches images stripped down to no source at
   all (a remote-only srcset, say); images still waiting on the inline-image
   bridge keep data-email-inline-cid and stay visible. The privacy banner above
   the frame is the only affordance the reader needs. */
img[data-remote-image-blocked],
img:not([src]):not([srcset]):not([data-email-inline-cid]) { display: none; }
blockquote {
	border-left: 3px solid #d1d5db;
	padding-left: 1em;
	margin-left: 0;
	color: #6b7280;
}
pre {
	background: #f3f4f6;
	padding: 12px;
	border-radius: 6px;
	overflow-x: auto;
	font-size: 13px;
}
table { border-collapse: collapse; max-width: 100%; }
td, th { padding: 4px 8px; }
p { margin: 4px 0; }
h1, h2, h3 { margin: 8px 0 4px; }
ul, ol { padding-left: 20px; margin: 4px 0; }
</style>
</head>
<body>${cleanBody}${iframeBridgeScript(nonce, plannedImages)}</body>
</html>`;

		if (mailboxId && plannedImages.length > 0) {
			void Promise.resolve().then(() => controller.signal.aborted
				? []
				: downloadInlineImages(
					plannedImages,
					mailboxId,
					messageId,
					controller.signal,
				)).then((downloaded) => {
				if (controller.signal.aborted) return;
				payloads = downloaded;
				postInlineImages();
			});
		} else {
			payloads = [];
		}

		return () => {
			controller.abort();
			window.removeEventListener("message", handleMessage);
		};
	}, [body, autoSize, inlineAttachments, loadRemoteImages, mailboxId, messageId]);

	const frame = (
		<iframe
			ref={iframeRef}
			className="block w-full border-0"
			style={autoSize ? { height: `${height}px` } : { height: "100%" }}
			sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
			title="Email content"
		/>
	);

	// The wrapper renders whether or not the banner does: swapping the root
	// element would remount the iframe and blank the message the moment the
	// sanitize walk reports that this body has remote images.
	return (
		<div className={autoSize ? "w-full" : "flex h-full w-full flex-col"}>
			{hasRemoteImages && (
				<div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
					<span>
						{loadRemoteImages
							? "Remote images are visible for this message."
							: "Remote images are blocked to protect your privacy."}
					</span>
					<button
						type="button"
						className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 shadow-sm hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
						onClick={() =>
							setRemoteImagesForMessageId((current) =>
								current === messageId ? null : messageId,
							)
						}
					>
						{loadRemoteImages ? "Hide images" : "Load images"}
					</button>
				</div>
			)}
			{frame}
		</div>
	);
}
