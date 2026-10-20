import { it } from "node:test";
import assert from "node:assert/strict";
import { rewriteInlineImages, isInlineAttachmentUrl, rasterImageType } from "./inline-images";

it("resolves Content-ID even when sender labels an image as an attachment", () => {
	const body = '<img src="cid:ABC%40test.png"><img src="cid:unknown">';
	assert.equal(rewriteInlineImages(body, "marketing@example.com", "mail", [{ id: "image", content_id: "<abc@test.png>" }]), '<img src="/api/v1/mailboxes/marketing%40example.com/emails/mail/attachments/image"><img src="cid:unknown">');
});
it("never fetches foreign or unrelated URLs with inbox credentials", () => {
	assert.ok(isInlineAttachmentUrl("/api/v1/mailboxes/a/emails/b/attachments/c"));
	for (const url of ["//evil.example/a", "https://evil.example/a", "/api/v1/config", "/api/v1/mailboxes/a/emails/b/attachments/c?redirect=evil"]) assert.equal(isInlineAttachmentUrl(url), false);
});
it("sniffs raster image bytes and rejects HTML and SVG", () => {
	assert.equal(rasterImageType(new Uint8Array([137,80,78,71,13,10,26,10])), "image/png");
	assert.equal(rasterImageType(new TextEncoder().encode('<svg onload="alert(1)">')), null);
	assert.equal(rasterImageType(new Uint8Array()), null);
});
