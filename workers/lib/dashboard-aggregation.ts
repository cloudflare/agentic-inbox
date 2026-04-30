// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

/**
 * Pure helpers for the operations dashboard. Live outside the Durable Object
 * so the bucketing + JSON-parsing logic is unit-testable without a
 * runtime SQL surface — the DO `getDashboardSummary` method composes these
 * with the SQL it owns.
 */

export type ThreatAction = "tag" | "quarantine" | "block";

export interface VerdictBucketRow {
	/** ISO 8601 timestamp from `emails.date`. */
	date: string | null;
	/** Raw `emails.security_verdict` cell — JSON-encoded `VerdictResult`. */
	security_verdict: string | null;
}

/**
 * Roll up recent emails into N equal-width time buckets, counting only
 * threat-actioned verdicts (tag/quarantine/block — `allow` is dropped).
 *
 * Buckets are oldest-first, so `result[0]` is the oldest window and
 * `result[N-1]` is the most recent. Rows outside the window or with
 * unparseable verdict JSON are silently dropped.
 */
export function bucketThreatPressure(
	rows: VerdictBucketRow[],
	options: { now?: Date; bucketCount?: number; windowHours?: number } = {},
): number[] {
	const now = options.now ?? new Date();
	const bucketCount = options.bucketCount ?? 12;
	const windowHours = options.windowHours ?? 24;

	const windowMs = windowHours * 60 * 60 * 1000;
	const windowStart = now.getTime() - windowMs;
	const bucketMs = windowMs / bucketCount;
	const buckets = new Array<number>(bucketCount).fill(0);

	for (const row of rows) {
		if (!row.date || !row.security_verdict) continue;

		const action = parseVerdictAction(row.security_verdict);
		if (action !== "tag" && action !== "quarantine" && action !== "block") continue;

		const t = Date.parse(row.date);
		if (Number.isNaN(t)) continue;
		if (t < windowStart || t > now.getTime()) continue;

		const idx = Math.min(
			Math.floor((t - windowStart) / bucketMs),
			bucketCount - 1,
		);
		buckets[idx] += 1;
	}

	return buckets;
}

function parseVerdictAction(json: string): string | null {
	try {
		const parsed = JSON.parse(json) as { action?: unknown };
		return typeof parsed.action === "string" ? parsed.action : null;
	} catch {
		return null;
	}
}

export interface PipelineSuccessInput {
	completed: number;
	failed: number;
}

/**
 * Compute the pipeline-success ratio over the deep-scan-status counts. Returns
 * `null` when there's no data to report (UI surfaces an "—" placeholder rather
 * than a misleading 0%).
 */
export function pipelineSuccessRate(input: PipelineSuccessInput): number | null {
	const total = input.completed + input.failed;
	if (total === 0) return null;
	return input.completed / total;
}
