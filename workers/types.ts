// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file and at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	TEAM_DOMAINS?: string;
	APP_NAME?: string;
	ADMIN_EMAIL?: string;
	ADMIN_PASSWORD?: string;
	/** Dedicated R2 bucket for mailbox signature/logo assets. Bind this in Cloudflare. */
	SIGNATURE_ASSETS: R2Bucket;
}
