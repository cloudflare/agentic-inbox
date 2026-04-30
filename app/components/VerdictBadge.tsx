// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ShieldCheckIcon, ShieldWarningIcon, ShieldIcon } from "@phosphor-icons/react";
import { parseVerdict, type Email } from "~/types";

/**
 * Compact verdict pill for the email list row. Renders nothing when the
 * security pipeline didn't run for this email.
 */
export default function VerdictBadge({ email }: { email: Pick<Email, "security_verdict" | "security_score"> }) {
	const verdict = parseVerdict(email.security_verdict);
	if (!verdict) return null;
	if (verdict.action === "allow") return null;

	const { icon, label, className } = presentation(verdict.action);
	return (
		<span
			title={verdict.explanation}
			className={`shrink-0 inline-flex items-center gap-1 text-xs font-medium rounded-full px-1.5 py-0.5 ${className}`}
		>
			{icon}
			{label}
		</span>
	);
}

function presentation(action: string) {
	switch (action) {
		case "quarantine":
		case "block":
			return {
				icon: <ShieldWarningIcon size={12} weight="fill" />,
				label: action === "block" ? "Blocked" : "Quarantined",
				className: "text-danger bg-paper-3",
			};
		case "tag":
			return {
				icon: <ShieldIcon size={12} weight="bold" />,
				label: "Suspicious",
				className: "text-suspect bg-paper-3",
			};
		default:
			return {
				icon: <ShieldCheckIcon size={12} />,
				label: "Safe",
				className: "text-ink-3",
			};
	}
}
