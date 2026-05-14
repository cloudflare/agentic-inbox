// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export function logSendRateLimitHit(
	mailboxId: string,
	source: string,
	error: string,
) {
	console.warn("Send rate limit hit", { mailboxId, source, error });
}
