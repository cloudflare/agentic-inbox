// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useState } from "react";
import {
	CaretDownIcon,
	CaretUpIcon,
	ShieldCheckIcon,
	ShieldWarningIcon,
	ShieldIcon,
} from "@phosphor-icons/react";
import { parseVerdict, type Email } from "~/types";

/**
 * Renders the security pipeline's verdict for an email: action, score, auth
 * chips (SPF/DKIM/DMARC), classifier label, and a collapsible signals list.
 */
export default function SecurityVerdictPanel({ email }: { email: Email }) {
	const verdict = parseVerdict(email.security_verdict);
	const [expanded, setExpanded] = useState(false);

	if (!verdict) return null;
	// Quiet path for the normal allow case, but surface hard-block /
	// attachment-block explicitly even when the user is reading the
	// quarantined message.
	if (verdict.action === "allow"
		&& verdict.triage !== "hard_block"
		&& verdict.triage !== "attachment_block") return null;

	const { borderClass, bgClass, iconColorClass, icon, headline } = ui(verdict.action);
	const triageTag = verdict.triage === "hard_allow"
		? "allowlist fast-path"
		: verdict.triage === "hard_block"
			? "triage hard-block"
			: verdict.triage === "attachment_block"
				? "blocked attachment type"
				: null;

	return (
		<div className={`px-4 md:px-6 pt-3`}>
			<div className={`rounded-lg border ${borderClass} ${bgClass} text-sm`}>
				<button
					type="button"
					className="w-full flex items-center gap-2 px-3 py-2 text-left"
					onClick={() => setExpanded((e) => !e)}
				>
					<span className={iconColorClass}>{icon}</span>
					<span className="font-medium text-ink">{headline}</span>
					{triageTag && (
						<span className="text-xs rounded-full bg-paper-3 px-1.5 py-0.5 text-ink-3">
							{triageTag}
						</span>
					)}
					<span className="text-xs text-ink-3 ml-1">score {verdict.score}/100</span>
					<span className="ml-auto text-ink-3">
						{expanded ? <CaretUpIcon size={16} /> : <CaretDownIcon size={16} />}
					</span>
				</button>
				{expanded && (
					<div className="px-3 pb-3 pt-0 space-y-2">
						<div className="text-ink">{verdict.explanation}</div>

						<div className="flex flex-wrap gap-1.5">
							<AuthChip label="SPF" value={verdict.auth.spf} />
							<AuthChip label="DKIM" value={verdict.auth.dkim} />
							<AuthChip label="DMARC" value={verdict.auth.dmarc} />
							<ClassifierChip label={verdict.classification.label} confidence={verdict.classification.confidence} />
						</div>

						{verdict.classification.reasoning && (
							<div className="text-xs text-ink-3 italic">
								Classifier: "{verdict.classification.reasoning}"
							</div>
						)}

						{verdict.signals.length > 0 && (
							<div>
								<div className="text-xs font-medium text-ink-3 mb-1">Contributing signals</div>
								<ul className="text-xs text-ink list-disc ml-4 space-y-0.5">
									{verdict.signals.map((s, i) => <li key={i}>{s}</li>)}
								</ul>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function ui(action: string) {
	switch (action) {
		case "quarantine":
		case "block":
			return {
				borderClass: "border-danger/40",
				bgClass: "bg-paper-3",
				iconColorClass: "text-danger",
				icon: <ShieldWarningIcon size={16} weight="fill" />,
				headline: action === "block" ? "Blocked by security pipeline" : "Quarantined by security pipeline",
			};
		case "tag":
			return {
				borderClass: "border-suspect/40",
				bgClass: "bg-paper-3",
				iconColorClass: "text-suspect",
				icon: <ShieldIcon size={16} weight="bold" />,
				headline: "Flagged as suspicious",
			};
		default:
			return {
				borderClass: "border-line",
				bgClass: "bg-paper-3",
				iconColorClass: "text-ink-3",
				icon: <ShieldCheckIcon size={16} />,
				headline: "Security verdict",
			};
	}
}

function AuthChip({ label, value }: { label: string; value: string }) {
	const color =
		value === "pass" ? "text-safe" :
		value === "fail" || value === "softfail" ? "text-danger" :
		"text-ink-3";
	return (
		<span className="text-xs rounded border border-line px-1.5 py-0.5 bg-paper-3">
			<span className="text-ink-3">{label} </span>
			<span className={`font-medium ${color}`}>{value}</span>
		</span>
	);
}

function ClassifierChip({ label, confidence }: { label: string; confidence: number }) {
	const color =
		label === "phishing" || label === "bec" ? "text-danger" :
		label === "suspicious" ? "text-suspect" :
		label === "spam" ? "text-ink-3" :
		"text-safe";
	return (
		<span className="text-xs rounded border border-line px-1.5 py-0.5 bg-paper-3">
			<span className="text-ink-3">LLM </span>
			<span className={`font-medium ${color}`}>{label}</span>
			<span className="text-ink-3"> ({Math.round(confidence * 100)}%)</span>
		</span>
	);
}
