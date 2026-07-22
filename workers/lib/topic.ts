// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

export interface TopicContext {
	topicId: string;
	title: string;
	mailboxId: string;
	selectedEmailIds: string[];
	content: string;
	createdAt: string;
}

async function hmac(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function dispatchTopic(env: Env, topic: TopicContext): Promise<{ mode: "external-runner" | "cloudflare-agent"; jobId: string; status: string }> {
	const jobId = crypto.randomUUID();
	const payload = JSON.stringify({ jobId, topic });
	if (!env.EXTERNAL_RUNNER_URL) {
		return { mode: "cloudflare-agent", jobId, status: "ready" };
	}
	if (!env.EXTERNAL_RUNNER_SECRET) throw new Error("EXTERNAL_RUNNER_SECRET is not configured");
	const signature = await hmac(env.EXTERNAL_RUNNER_SECRET, payload);
	const response = await fetch(env.EXTERNAL_RUNNER_URL, {
		method: "POST",
		headers: { "content-type": "application/json", "x-topic-signature": signature, "x-topic-job-id": jobId },
		body: payload,
	});
	if (!response.ok) throw new Error(`External Topic runner rejected the job (${response.status})`);
	return { mode: "external-runner", jobId, status: "dispatched" };
}
