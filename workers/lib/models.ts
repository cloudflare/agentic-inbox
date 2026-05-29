// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export const WORKERS_AI_MODELS = {
	emailAgent: "@cf/moonshotai/kimi-k2.6",
	promptInjectionScanner: "@cf/meta/llama-3.1-8b-instruct-fast",
	draftVerifier: "@cf/meta/llama-4-scout-17b-16e-instruct",
} as const;
