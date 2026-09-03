// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
}

/**
 * The subset of Cloudflare's `ForwardableEmailMessage` that inbound handling needs.
 *
 * `to` / `from` are the SMTP envelope addresses. `to` is what Email Routing actually
 * delivered to, which is the authoritative mailbox for the message when more than one
 * domain is served. Both are optional so replayed or hand-built events (local dev,
 * tests) that carry only the raw stream still type-check.
 */
export interface IncomingEmailEvent {
	raw: ReadableStream;
	rawSize: number;
	to?: string;
	from?: string;
}
