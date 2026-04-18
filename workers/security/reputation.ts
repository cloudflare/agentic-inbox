// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-sender reputation tracking. Stored on the mailbox DO so each mailbox
 * has its own view (senders that are trusted by one user can be new/untrusted
 * for another — correct behaviour for a personal inbox).
 */

export interface SenderReputation {
	sender: string;
	first_seen: string;
	last_seen: string;
	message_count: number;
	avg_score: number;
	flagged: boolean;
}

export function scoreReputation(rep: SenderReputation | null): { score: number; reasons: string[] } {
	const reasons: string[] = [];
	let score = 0;
	if (!rep || rep.message_count === 0) {
		score += 5;
		reasons.push("first-time sender");
		return { score, reasons };
	}
	if (rep.flagged) { score += 15; reasons.push("sender previously flagged"); }
	// Consistently-bad history adds suspicion. The score here is a small
	// nudge rather than a hard signal — the `flagged` branch above is the
	// deliberate-action path; this catches senders whose verdicts have been
	// piling up without anyone flipping the flag.
	if (rep.avg_score > 70) {
		score += 10;
		reasons.push(`bad sender history (avg ${rep.avg_score.toFixed(0)})`);
	}
	return { score, reasons };
}
