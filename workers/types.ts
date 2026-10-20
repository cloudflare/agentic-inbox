// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	// EasyRent custom bindings
	CHATWOOT_RELAY_URL: string;
	CHATWOOT_INGRESS_PASSWORD: string;
	STALWART_FORWARD_URL: string;
	STALWART_ACCOUNT_PASSWORD: string;
	RESERVATION_AGENT_URL: string;
}
