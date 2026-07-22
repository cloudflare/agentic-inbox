// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Format a count for compact display (e.g. 1234 -> "1.2k"). */
export function formatCount(n: number | null): string {
	if (n == null) return "—";
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
