// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Input, Switch } from "@cloudflare/kumo";
import { ShieldIcon } from "@phosphor-icons/react";
import type { SecuritySettings, BusinessHoursSettings, VerdictThresholdSettings } from "~/types";

/**
 * Per-mailbox security settings UI. Mirrors `MailboxSecuritySettings` in
 * `workers/security/settings.ts` so the same JSON shape round-trips through
 * R2.
 *
 * Contents are intentionally low-density: each control corresponds to one
 * field on the server-side settings object, and each has a short explanatory
 * blurb because the behavior is far from obvious. Defaults here match the
 * DEFAULT_SECURITY_SETTINGS on the server so an empty form shows the same
 * state you'd get from leaving the section unset entirely.
 */

const DEFAULT_THRESHOLDS: VerdictThresholdSettings = { tag: 30, quarantine: 60, block: 80 };
const DEFAULT_BUSINESS_HOURS: BusinessHoursSettings = {
	timezone: "",
	start_hour: 9,
	end_hour: 18,
	weekdays_only: true,
	boost_on_off_hours: false,
};

export interface SecuritySettingsPanelProps {
	value: SecuritySettings | undefined;
	onChange: (next: SecuritySettings) => void;
}

export function SecuritySettingsPanel({ value, onChange }: SecuritySettingsPanelProps) {
	const s = value ?? {};
	const thresholds = s.thresholds ?? DEFAULT_THRESHOLDS;
	const bh = s.business_hours;

	const patch = (partial: Partial<SecuritySettings>) => onChange({ ...s, ...partial });

	return (
		<div className="pp-card p-5 space-y-5">
			<div className="flex items-center gap-2">
				<ShieldIcon size={16} weight="duotone" className="text-ink-3" />
				<span className="text-sm font-medium text-ink">Security</span>
				{s.enabled ? (
					s.learning_mode
						? <Badge variant="secondary">Learning</Badge>
						: <Badge variant="primary">Active</Badge>
				) : <Badge variant="secondary">Disabled</Badge>}
			</div>

			<div className="space-y-3">
				<Switch
					label="Enable security pipeline"
					checked={!!s.enabled}
					onCheckedChange={(v) => patch({ enabled: v })}
				/>
				<p className="text-xs text-ink-3 -mt-2">
					Runs SPF/DKIM/DMARC parse, URL heuristics, and an LLM classifier on incoming mail.
					Disabled by default so existing mailboxes aren't affected until you opt in.
				</p>

				<Switch
					label="Learning mode (tag only, never quarantine)"
					checked={!!s.learning_mode}
					onCheckedChange={(v) => patch({ learning_mode: v })}
					disabled={!s.enabled}
				/>
				<p className="text-xs text-ink-3 -mt-2">
					Safe way to dial-in thresholds: verdicts still compute but are capped at "tag".
					Use this for a week before flipping off to audit false-positive rate.
				</p>
			</div>

			{/* Thresholds */}
			<div className="border-t border-line pt-5">
				<div className="text-xs font-medium text-ink mb-2">Score thresholds</div>
				<p className="text-xs text-ink-3 mb-3">
					Score 0–100 aggregated from auth, URL, classifier, and reputation signals.
					Values below take effect when the pipeline is enabled.
				</p>
				<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
					<Input
						label="Tag"
						type="number"
						min={0}
						max={100}
						value={String(thresholds.tag)}
						onChange={(e) => patch({ thresholds: { ...thresholds, tag: clampScore(e.target.value, DEFAULT_THRESHOLDS.tag) } })}
						disabled={!s.enabled}
					/>
					<Input
						label="Quarantine"
						type="number"
						min={0}
						max={100}
						value={String(thresholds.quarantine)}
						onChange={(e) => patch({ thresholds: { ...thresholds, quarantine: clampScore(e.target.value, DEFAULT_THRESHOLDS.quarantine) } })}
						disabled={!s.enabled}
					/>
					<Input
						label="Block"
						type="number"
						min={0}
						max={100}
						value={String(thresholds.block)}
						onChange={(e) => patch({ thresholds: { ...thresholds, block: clampScore(e.target.value, DEFAULT_THRESHOLDS.block) } })}
						disabled={!s.enabled}
					/>
				</div>
			</div>

			{/* Authentication-Results trust */}
			<div className="border-t border-line pt-5">
				<div className="text-xs font-medium text-ink mb-2">Trusted authentication servers</div>
				<p className="text-xs text-ink-3 mb-3">
					Comma-separated list of authserv-id values (e.g. <code className="text-ink">mx.cloudflare.net, mx.google.com</code>).
					Only <code className="text-ink">Authentication-Results</code> headers matching these authservs contribute to the SPF/DKIM/DMARC verdict —
					this prevents an attacker-controlled upstream relay from forging a pass verdict.
					Leave empty to trust any authserv (less secure).
				</p>
				<Input
					value={(s.trusted_authserv_ids ?? []).join(", ")}
					onChange={(e) => patch({ trusted_authserv_ids: parseList(e.target.value) })}
					placeholder="mx.cloudflare.net, mx.google.com"
					disabled={!s.enabled}
				/>
			</div>

			{/* Allowlists */}
			<div className="border-t border-line pt-5">
				<div className="text-xs font-medium text-ink mb-2">Allowlists (hard-allow when DMARC passes)</div>
				<p className="text-xs text-ink-3 mb-3">
					Matched senders skip the classifier and are allowed — <em>only</em> when DMARC also passes.
					Without the DMARC requirement, the allowlist alone would let any attacker spoof a trusted From: address.
				</p>
				<div className="space-y-3">
					<Input
						label="Allowed senders (comma-separated)"
						value={(s.allowlist_senders ?? []).join(", ")}
						onChange={(e) => patch({ allowlist_senders: parseList(e.target.value) })}
						placeholder="ceo@company.com, payroll@vendor.com"
						disabled={!s.enabled}
					/>
					<Input
						label="Allowed domains (comma-separated; subdomains are included)"
						value={(s.allowlist_domains ?? []).join(", ")}
						onChange={(e) => patch({ allowlist_domains: parseList(e.target.value) })}
						placeholder="company.com, trustedvendor.com"
						disabled={!s.enabled}
					/>
				</div>
			</div>

			{/* Automations */}
			<div className="border-t border-line pt-5">
				<div className="text-xs font-medium text-ink mb-3">Automations</div>
				<div className="space-y-3">
					<Switch
						label="Hard-block on confirmed threat-intel hit"
						checked={s.intel_auto_block ?? true}
						onCheckedChange={(v) => patch({ intel_auto_block: v })}
						disabled={!s.enabled}
					/>
					<Switch
						label="Hard-allow trusted senders"
						checked={s.trusted_auto_allow ?? true}
						onCheckedChange={(v) => patch({ trusted_auto_allow: v })}
						disabled={!s.enabled}
					/>
					<Input
						label="History-based trust: min prior messages"
						type="number"
						min={0}
						value={String(s.trusted_auto_allow_min_messages ?? 10)}
						onChange={(e) => patch({ trusted_auto_allow_min_messages: clampInt(e.target.value, 10, 0, 10_000) })}
						disabled={!s.enabled || s.trusted_auto_allow === false}
					/>
					<p className="text-xs text-ink-3 -mt-2">
						Senders with at least this many prior messages and an average score &lt; 20 auto-allow when DMARC passes.
						Set to 0 to require an explicit allowlist entry.
					</p>
				</div>
			</div>

			{/* Business hours */}
			<div className="border-t border-line pt-5">
				<div className="text-xs font-medium text-ink mb-2">Business hours</div>
				<p className="text-xs text-ink-3 mb-3">
					Adds a small score nudge (+10) to mail received outside your working hours —
					BEC/wire-fraud asks disproportionately land at 3am and on weekends.
					Scoring only; never short-circuits to quarantine on time alone.
				</p>
				<Switch
					label="Boost score on off-hours delivery"
					checked={!!bh?.boost_on_off_hours}
					onCheckedChange={(v) => patch({
						business_hours: { ...(bh ?? DEFAULT_BUSINESS_HOURS), boost_on_off_hours: v },
					})}
					disabled={!s.enabled}
				/>
				<div className="grid grid-cols-2 gap-3 mt-3">
					<Input
						label="Timezone (IANA)"
						value={bh?.timezone ?? ""}
						onChange={(e) => patch({
							business_hours: { ...(bh ?? DEFAULT_BUSINESS_HOURS), timezone: e.target.value },
						})}
						placeholder="America/New_York"
						disabled={!s.enabled || !bh?.boost_on_off_hours}
					/>
					<Switch
						label="Weekdays only"
						checked={bh?.weekdays_only ?? true}
						onCheckedChange={(v) => patch({
							business_hours: { ...(bh ?? DEFAULT_BUSINESS_HOURS), weekdays_only: v },
						})}
						disabled={!s.enabled || !bh?.boost_on_off_hours}
					/>
					<Input
						label="Start hour (0–23, local)"
						type="number"
						min={0}
						max={23}
						value={String(bh?.start_hour ?? 9)}
						onChange={(e) => patch({
							business_hours: { ...(bh ?? DEFAULT_BUSINESS_HOURS), start_hour: clampInt(e.target.value, 9, 0, 23) },
						})}
						disabled={!s.enabled || !bh?.boost_on_off_hours}
					/>
					<Input
						label="End hour (exclusive, 0–23)"
						type="number"
						min={0}
						max={23}
						value={String(bh?.end_hour ?? 18)}
						onChange={(e) => patch({
							business_hours: { ...(bh ?? DEFAULT_BUSINESS_HOURS), end_hour: clampInt(e.target.value, 18, 0, 23) },
						})}
						disabled={!s.enabled || !bh?.boost_on_off_hours}
					/>
				</div>
			</div>
		</div>
	);
}

function parseList(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

function clampScore(raw: string, fallback: number): number {
	return clampInt(raw, fallback, 0, 100);
}

function clampInt(raw: string, fallback: number, min: number, max: number): number {
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}
