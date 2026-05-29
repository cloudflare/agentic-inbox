// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";
import type { Email, SpamClassification } from "~/types";

function parseClassification(email: Email): SpamClassification | null {
	if (!email.spam_classification) return null;
	try {
		return JSON.parse(email.spam_classification) as SpamClassification;
	} catch {
		return null;
	}
}

function formatCheck(value?: string | boolean | null) {
	if (value === true) return "present";
	if (value === false) return "missing";
	return value || "not observed";
}

export default function SpamClassificationBanner({ email }: { email: Email }) {
	const classification = parseClassification(email);
	if (!classification) return null;

	const toneClass =
		classification.verdict === "spam"
			? "border-red-200 bg-red-50 text-red-950"
			: classification.verdict === "suspicious"
				? "border-amber-200 bg-amber-50 text-amber-950"
				: "border-emerald-200 bg-emerald-50 text-emerald-950";

	const dns = classification.checks?.dns;
	const auth = classification.checks?.authentication;

	return (
		<div className={`mx-4 mt-4 rounded-md border px-3 py-2 text-xs md:mx-6 ${toneClass}`}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-semibold">Spam classification</span>
				<Badge variant="secondary">{classification.verdict}</Badge>
				<span>Score {classification.score}/100</span>
			</div>
			<div className="mt-1 text-[11px] leading-5">
				SPF {formatCheck(auth?.spf || dns?.hasSpfRecord)}, DKIM{" "}
				{formatCheck(auth?.dkim || dns?.dkimRecordFound)}, DMARC{" "}
				{formatCheck(auth?.dmarc || dns?.hasDmarcRecord)}, MX{" "}
				{formatCheck(dns?.hasMx)}
			</div>
			{classification.reasons.length > 0 && (
				<div className="mt-1 text-[11px] leading-5">
					{classification.reasons.slice(0, 4).join("; ")}
				</div>
			)}
		</div>
	);
}
