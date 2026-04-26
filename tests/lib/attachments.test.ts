import { describe, expect, it } from "vitest";
import { attachmentObjectKey } from "../../workers/lib/attachments";

/**
 * The R2 key layout is load-bearing: the mailbox-delete reap
 * (`workers/index.ts:reapMailbox`) reconstructs every key from
 * `(email_id, attachment_id, filename)` triples pulled out of the
 * Durable Object. If the write path and the read/delete path ever
 * drift apart, deletes become silent no-ops and blobs orphan in R2
 * forever. These tests pin the format in exactly one place.
 */
describe("attachmentObjectKey", () => {
	it("uses the attachments/<emailId>/<attachmentId>/<filename> layout", () => {
		expect(attachmentObjectKey("email-1", "att-1", "report.pdf")).toBe(
			"attachments/email-1/att-1/report.pdf",
		);
	});

	it("preserves whatever filename the caller supplies", () => {
		// Filenames are sanitized at the write boundary (storeAttachments
		// and the email-receive path). This helper trusts its inputs so
		// read-side reconstruction matches byte-for-byte.
		const weird = "spaces and.dots.zip";
		expect(attachmentObjectKey("e", "a", weird)).toBe(`attachments/e/a/${weird}`);
	});

	it("round-trips: prefix + three segments separated by slashes", () => {
		const key = attachmentObjectKey("E", "A", "f.bin");
		expect(key.startsWith("attachments/")).toBe(true);
		expect(key.split("/")).toEqual(["attachments", "E", "A", "f.bin"]);
	});
});
