// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env {
	DB: D1Database;
	AI: Ai;
	TRIAGE_QUEUE: Queue<TriageMessage>;
	HUB_ADMIN_KEY: string;
}

export interface TriageMessage {
	kind: "event";
	event_uuid: string;
}

export interface AuthedOrg {
	uuid: string;
	name: string;
	trust: number;
}
