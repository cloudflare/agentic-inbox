// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export const AI_MODELS = {
	emailAgent: "@cf/moonshotai/kimi-k2.5",
	autoDraft: "@cf/moonshotai/kimi-k2.5",
	promptInjectionScanner: "@cf/meta/llama-3.1-8b-instruct-fast",
	draftVerifier: "@cf/meta/llama-4-scout-17b-16e-instruct",
} as const;

export type AIModelKey = keyof typeof AI_MODELS;

const ENV_MODEL_KEYS = {
	emailAgent: "EMAIL_AGENT_MODEL",
	autoDraft: "AUTO_DRAFT_MODEL",
	promptInjectionScanner: "PROMPT_INJECTION_MODEL",
	draftVerifier: "DRAFT_VERIFIER_MODEL",
} as const satisfies Record<AIModelKey, string>;

export function getAIModel(key: AIModelKey, env?: object): string {
	const envKey = ENV_MODEL_KEYS[key];
	const configuredModel = env
		? (env as Record<string, unknown>)[envKey]
		: undefined;

	return typeof configuredModel === "string" && configuredModel.trim()
		? configuredModel.trim()
		: AI_MODELS[key];
}
