import { describe, expect, it } from "vitest";
import {
	aggregateAttachmentSignals,
	finalExtension,
	scoreAttachment,
} from "../../workers/intel/attachment-checks";

describe("finalExtension", () => {
	it("returns lowercased extension", () => {
		expect(finalExtension("Report.PDF")).toBe("pdf");
	});
	it("returns empty for extensionless files", () => {
		expect(finalExtension("LICENSE")).toBe("");
	});
	it("ignores trailing dots", () => {
		expect(finalExtension("report.")).toBe("");
	});
	it("handles multi-dot filenames (last wins)", () => {
		expect(finalExtension("archive.tar.gz")).toBe("gz");
	});
});

describe("scoreAttachment", () => {
	it("flags dangerous extensions aggressively", () => {
		const v = scoreAttachment({ filename: "invoice.exe", mimetype: "application/octet-stream", size: 1024 });
		expect(v.flags).toContain("dangerous_extension");
		expect(v.score).toBeGreaterThanOrEqual(40);
	});

	it("flags macro-enabled Office docs", () => {
		const v = scoreAttachment({ filename: "quarterly-report.docm", mimetype: "application/vnd.ms-word.document.macroEnabled.12", size: 2048 });
		expect(v.flags).toContain("macro_enabled_office");
	});

	it("flags the classic invoice.pdf.exe double-extension pattern", () => {
		const v = scoreAttachment({ filename: "invoice.pdf.exe", mimetype: "application/octet-stream", size: 512 });
		expect(v.flags).toContain("dangerous_extension");
		expect(v.flags).toContain("double_extension");
	});

	it("does not flag legitimate archives with `.tar.gz` as double-extension", () => {
		const v = scoreAttachment({ filename: "release.tar.gz", mimetype: "application/gzip", size: 10_000 });
		expect(v.flags).not.toContain("double_extension");
	});

	it("flags MIME/extension mismatches (pdf MIME with .exe extension)", () => {
		const v = scoreAttachment({ filename: "contract.exe", mimetype: "application/pdf", size: 1_000 });
		expect(v.flags).toContain("extension_mime_mismatch");
		expect(v.flags).toContain("dangerous_extension");
	});

	it("does not flag well-known mime/ext matches", () => {
		const v = scoreAttachment({ filename: "photo.png", mimetype: "image/png", size: 10_000 });
		expect(v.flags).toEqual([]);
		expect(v.score).toBe(0);
	});

	it("passes silently on MIME types we don't have a map for", () => {
		const v = scoreAttachment({ filename: "data.bin", mimetype: "application/some-novel-type", size: 2000 });
		expect(v.flags).not.toContain("extension_mime_mismatch");
	});

	it("flags archives whose filename advertises an executable", () => {
		const v = scoreAttachment({ filename: "invoice_exe.zip", mimetype: "application/zip", size: 1000 });
		expect(v.flags).toContain("executable_in_archive_name");
	});

	it("nudges commercial-bait archive names slightly", () => {
		const v = scoreAttachment({ filename: "invoice-123.zip", mimetype: "application/zip", size: 1000 });
		expect(v.flags).toContain("suspicious_archive_name");
		expect(v.score).toBeLessThan(15);
	});

	it("flags zero-byte attachments", () => {
		const v = scoreAttachment({ filename: "empty.pdf", mimetype: "application/pdf", size: 0 });
		expect(v.flags).toContain("zero_byte");
	});

	it("clamps scores to the [0, 100] range", () => {
		const v = scoreAttachment({ filename: "invoice.pdf.exe", mimetype: "application/pdf", size: 0 });
		expect(v.score).toBeLessThanOrEqual(100);
		expect(v.score).toBeGreaterThanOrEqual(0);
	});
});

describe("aggregateAttachmentSignals", () => {
	it("caps contribution at 30 so attachments can't dominate", () => {
		const v = aggregateAttachmentSignals([
			scoreAttachment({ filename: "a.exe", mimetype: "application/pdf", size: 0 }),
			scoreAttachment({ filename: "b.docm", mimetype: "x", size: 0 }),
		]);
		expect(v.score).toBeLessThanOrEqual(30);
	});

	it("returns zero when every attachment is clean", () => {
		const v = aggregateAttachmentSignals([
			scoreAttachment({ filename: "photo.png", mimetype: "image/png", size: 10_000 }),
		]);
		expect(v.score).toBe(0);
	});

	it("de-duplicates repeated reasons across attachments", () => {
		const v = aggregateAttachmentSignals([
			scoreAttachment({ filename: "a.exe", mimetype: "application/octet-stream", size: 100 }),
			scoreAttachment({ filename: "b.exe", mimetype: "application/octet-stream", size: 100 }),
		]);
		expect(v.reasons.length).toBeLessThanOrEqual(2);
	});
});
