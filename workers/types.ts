// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Omit<
	Cloudflare.Env,
	"AI" | "EMAIL_AGENT" | "EMAIL_MCP" | "ENABLE_AI_AGENT" | "ENABLE_MCP"
> {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	ENABLE_AI_AGENT?: string | boolean;
	ENABLE_MCP?: string | boolean;
	AI?: Ai;
	EMAIL_AGENT?: DurableObjectNamespace<import("./app").EmailAgent>;
	EMAIL_MCP?: DurableObjectNamespace<import("./app").EmailMCP>;
}
