// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";
import type { AppFeatures } from "../../shared/features";

/**
 * Returns whether the AI Chat Agent is enabled.
 * Requires explicit flag to not be false, plus Workers AI binding (env.AI)
 * and EmailAgent Durable Object binding (env.EMAIL_AGENT).
 */
export function isAgentEnabled(env: Env): boolean {
	const flag = env.ENABLE_AI_AGENT;
	if (flag === false || flag === "false" || flag === "0") {
		return false;
	}
	return Boolean(env.AI && env.EMAIL_AGENT);
}

/**
 * Returns whether the MCP server endpoint is enabled.
 * Requires explicit flag to not be false, plus EmailMCP Durable Object binding (env.EMAIL_MCP).
 */
export function isMcpEnabled(env: Env): boolean {
	const flag = env.ENABLE_MCP;
	if (flag === false || flag === "false" || flag === "0") {
		return false;
	}
	return Boolean(env.EMAIL_MCP);
}

/**
 * Returns feature toggle statuses for the client.
 */
export function getAppFeatures(env: Env): AppFeatures {
	return {
		aiAgent: isAgentEnabled(env),
		mcp: isMcpEnabled(env),
	};
}
