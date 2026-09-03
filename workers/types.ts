// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** HS256 secret used to sign/verify iOS mobile session JWTs after Apple Sign In. */
	MOBILE_JWT_SECRET?: string;
	/** iOS app bundle ID — Apple identity token `aud` (e.g. com.example.AgenticInbox). */
	APPLE_CLIENT_ID?: string;
}
