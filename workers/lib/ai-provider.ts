// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createWorkersAI } from "workers-ai-provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { Env } from "../types";

const DEFAULT_WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.5";

interface AiProviderSetting {
	type: "workers-ai" | "openrouter";
	model: string;
}

/** Read the per-mailbox AI provider setting from R2. */
export async function getAiProviderSetting(
	env: Env,
	mailboxId: string,
): Promise<AiProviderSetting> {
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return { type: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL };

	const settings = (await obj.json()) as Record<string, unknown>;
	const provider = settings.aiProvider as AiProviderSetting | undefined;

	if (!provider?.type || !provider?.model) {
		return { type: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL };
	}

	if (provider.type === "openrouter" && !env.OPENROUTER_API_KEY) {
		return { type: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL };
	}

	return provider;
}

/** Resolve a LanguageModel instance for the given mailbox. */
export async function getModelForMailbox(
	env: Env,
	mailboxId: string,
): Promise<LanguageModel> {
	const setting = await getAiProviderSetting(env, mailboxId);

	if (setting.type === "openrouter" && env.OPENROUTER_API_KEY) {
		const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
		return openrouter(setting.model);
	}

	const workersai = createWorkersAI({ binding: env.AI });
	return workersai(setting.model || DEFAULT_WORKERS_AI_MODEL);
}
