// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "~/types";

interface EmailIframeProps {
	body: string;
	mailboxId?: string;
	emailId?: string;
	attachments?: Attachment[];
	autoSize?: boolean;
}

function attachmentUrl(mailboxId: string, emailId: string, attachmentId: string) {
	return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
	return await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/**
 * The email viewer is intentionally rendered in an opaque sandboxed iframe.
 * Such an iframe cannot send the mailbox session cookie with an API image
 * request. Fetch inline images in the authenticated parent page first, then
 * embed the bytes as data URLs inside the sandbox.
 */
async function rewriteCidImages(
	body: string,
	mailboxId?: string,
	emailId?: string,
	attachments?: Attachment[],
): Promise<string> {
	if (!body || !mailboxId || !emailId || !attachments?.length) return body;

	let result = body;
	const used = new Set<string>();

	for (const att of attachments) {
		if (!att.content_id) continue;
		const cid = att.content_id.replace(/^<|>$/g, "").trim();
		if (!cid) continue;
		const escapedCid = cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(`cid:\\s*<?${escapedCid}>?`, "gi");
		if (!re.test(result)) continue;

		try {
			const response = await fetch(attachmentUrl(mailboxId, emailId, att.id), {
				credentials: "include",
			});
			if (!response.ok) continue;
			const dataUrl = await blobToDataUrl(await response.blob());
			result = result.replace(re, dataUrl);
			used.add(att.id);
		} catch {
			// Keep the CID untouched if the authenticated fetch fails.
		}
	}

	// Gmail sometimes has the filename in alt while the stored Content-ID is
	// not preserved exactly. Cover that common form as well.
	for (const att of attachments) {
		if (used.has(att.id) || att.disposition !== "inline" || !att.filename) continue;
		const escapedName = att.filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(`(<img\\b[^>]*\\balt=["'])${escapedName}(["'][^>]*\\bsrc=["'])cid:[^"']+(["'])`, "gi");
		if (!re.test(result)) continue;
		try {
			const response = await fetch(attachmentUrl(mailboxId, emailId, att.id), { credentials: "include" });
			if (!response.ok) continue;
			const dataUrl = await blobToDataUrl(await response.blob());
			result = result.replace(re, `$1${att.filename}$2${dataUrl}$3`);
			used.add(att.id);
		} catch {
			// Keep the original CID.
		}
	}

	// Last-resort mapping for malformed messages where CID metadata differs.
	const inlineImages = attachments.filter((att) => !used.has(att.id) && att.disposition === "inline" && att.mimetype?.startsWith("image/"));
	const unresolved = [...result.matchAll(/cid:\s*<?[^>\s"']+>?/gi)];
	for (let i = 0; i < unresolved.length && i < inlineImages.length; i++) {
		try {
			const response = await fetch(attachmentUrl(mailboxId, emailId, inlineImages[i].id), { credentials: "include" });
			if (!response.ok) continue;
			const dataUrl = await blobToDataUrl(await response.blob());
			result = result.replace(unresolved[i][0], dataUrl);
		} catch {
			// Leave unresolved CID untouched rather than guessing.
		}
	}

	return result;
}

export default function EmailIframe({ body, mailboxId, emailId, attachments, autoSize }: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);
	const handleMessage = useCallback((event: MessageEvent) => {
		if (!autoSize || event.source !== iframeRef.current?.contentWindow) return;
		if (event.data && typeof event.data === "object" && event.data.__emailIframeHeight && typeof event.data.height === "number" && event.data.height > 0) setHeight(event.data.height);
	}, [autoSize]);

	useEffect(() => {
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [handleMessage]);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe || !body) return;
		let cancelled = false;

		(async () => {
			const rewrittenBody = await rewriteCidImages(body, mailboxId, emailId, attachments);
			if (cancelled || !iframeRef.current) return;
			const cleanBody = DOMPurify.sanitize(rewrittenBody, {
				USE_PROFILES: { html: true },
				FORBID_TAGS: ["style"],
				ADD_ATTR: ["target"],
				FORCE_BODY: true,
			});
			const padding = autoSize ? "0" : "24px";
			const heightScript = autoSize ? `<script>function reportHeight(){var h=document.body.scrollHeight;if(h>0)parent.postMessage({__emailIframeHeight:true,height:h},"*");}reportHeight();setTimeout(reportHeight,50);setTimeout(reportHeight,150);setTimeout(reportHeight,400);<\/script>` : "";
			iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; script-src 'unsafe-inline';"><style>*{box-sizing:border-box}html{background:#fff;color-scheme:light}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;background:#fff;padding:${padding};margin:0;word-wrap:break-word;overflow-wrap:break-word;${autoSize ? "overflow:hidden;" : ""}}[style*="position: fixed"],[style*="position:fixed"],[style*="position: absolute"],[style*="position:absolute"]{position:relative!important}a{color:#2563eb}img{max-width:100%;height:auto}blockquote{border-left:3px solid #d1d5db;padding-left:1em;margin-left:0;color:#6b7280}pre{background:#f3f4f6;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px}table{border-collapse:collapse;max-width:100%}td,th{padding:4px 8px}p{margin:4px 0}h1,h2,h3{margin:8px 0 4px}ul,ol{padding-left:20px;margin:4px 0}</style></head><body>${cleanBody}${heightScript}</body></html>`;
		})();

		return () => { cancelled = true; };
	}, [body, mailboxId, emailId, attachments, autoSize]);

	return <iframe ref={iframeRef} className="block w-full border-0" style={autoSize ? { height: `${height}px` } : { height: "100%" }} sandbox="allow-scripts allow-popups allow-top-navigation-by-user-activation" title="Email content" />;
}
