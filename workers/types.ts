// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	OPENROUTER_API_KEY?: string;
	GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
	GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
}
