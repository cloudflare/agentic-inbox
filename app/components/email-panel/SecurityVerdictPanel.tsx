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
					<span className="font-medium text-kumo-default">{headline}</span>
					{triageTag && (
						<span className="text-xs rounded-full bg-kumo-fill px-1.5 py-0.5 text-kumo-subtle">
							{triageTag}
						</span>
					)}
					<span className="text-xs text-kumo-subtle ml-1">score {verdict.score}/100</span>
					<span className="ml-auto text-kumo-subtle">
						{expanded ? <CaretUpIcon size={16} /> : <CaretDownIcon size={16} />}
					</span>
				</button>
				{expanded && (
					<div className="px-3 pb-3 pt-0 space-y-2">
						<div className="text-kumo-default">{verdict.explanation}</div>

						<div className="flex flex-wrap gap-1.5">
							<AuthChip label="SPF" value={verdict.auth.spf} />
							<AuthChip label="DKIM" value={verdict.auth.dkim} />
							<AuthChip label="DMARC" value={verdict.auth.dmarc} />
							<ClassifierChip label={verdict.classification.label} confidence={verdict.classification.confidence} />
						</div>

						{verdict.classification.reasoning && (
							<div className="text-xs text-kumo-subtle italic">
								Classifier: "{verdict.classification.reasoning}"
							</div>
						)}

						{verdict.signals.length > 0 && (
							<div>
								<div className="text-xs font-medium text-kumo-subtle mb-1">Contributing signals</div>
								<ul className="text-xs text-kumo-default list-disc ml-4 space-y-0.5">
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
				borderClass: "border-kumo-destructive/40",
				bgClass: "bg-kumo-fill",
				iconColorClass: "text-kumo-destructive",
				icon: <ShieldWarningIcon size={16} weight="fill" />,
				headline: action === "block" ? "Blocked by security pipeline" : "Quarantined by security pipeline",
			};
		case "tag":
			return {
				borderClass: "border-kumo-warning/40",
				bgClass: "bg-kumo-fill",
				iconColorClass: "text-kumo-warning",
				icon: <ShieldIcon size={16} weight="bold" />,
				headline: "Flagged as suspicious",
			};
		default:
			return {
				borderClass: "border-kumo-line",
				bgClass: "bg-kumo-elevated",
				iconColorClass: "text-kumo-subtle",
				icon: <ShieldCheckIcon size={16} />,
				headline: "Security verdict",
			};
	}
}

function AuthChip({ label, value }: { label: string; value: string }) {
	const color =
		value === "pass" ? "text-kumo-success" :
		value === "fail" || value === "softfail" ? "text-kumo-destructive" :
		"text-kumo-subtle";
	return (
		<span className="text-xs rounded border border-kumo-line px-1.5 py-0.5 bg-kumo-elevated">
			<span className="text-kumo-subtle">{label} </span>
			<span className={`font-medium ${color}`}>{value}</span>
		</span>
	);
}

function ClassifierChip({ label, confidence }: { label: string; confidence: number }) {
	const color =
		label === "phishing" || label === "bec" ? "text-kumo-destructive" :
		label === "suspicious" ? "text-kumo-warning" :
		label === "spam" ? "text-kumo-subtle" :
		"text-kumo-success";
	return (
		<span className="text-xs rounded border border-kumo-line px-1.5 py-0.5 bg-kumo-elevated">
			<span className="text-kumo-subtle">LLM </span>
			<span className={`font-medium ${color}`}>{label}</span>
			<span className="text-kumo-subtle"> ({Math.round(confidence * 100)}%)</span>
		</span>
	);
}
