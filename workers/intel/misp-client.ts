// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * MISP-compatible client. Posts events to our hub (or any MISP instance that
 * accepts the standard REST shape) and pulls the hub's published feeds.
 *
 * Auth matches MISP convention: `Authorization: <api-key>` (not Bearer).
 */

import type { MispEvent } from "./report";

export interface MispClientConfig {
	baseUrl: string;
	apiKey: string;
}

export class MispClient {
	constructor(private cfg: MispClientConfig) {}

	async postEvent(event: MispEvent): Promise<{ uuid: string } | null> {
		const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/events`, {
			method: "POST",
			headers: {
				"Authorization": this.cfg.apiKey,
				"Accept": "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.error(`hub POST /events ${res.status}: ${body.slice(0, 200)}`);
			return null;
		}
		const json = (await res.json().catch(() => null)) as { Event?: { uuid?: string } } | null;
		return json?.Event?.uuid ? { uuid: json.Event.uuid } : null;
	}

	async fetchDestroyList(opts: { sharingGroup?: string } = {}): Promise<string[]> {
		const params = opts.sharingGroup
			? `?sharing_group=${encodeURIComponent(opts.sharingGroup)}`
			: "";
		const res = await fetch(
			`${this.cfg.baseUrl.replace(/\/$/, "")}/feeds/destroylist.txt${params}`,
			{
				headers: { "Authorization": this.cfg.apiKey, "Accept": "text/plain" },
				signal: AbortSignal.timeout(10000),
			},
		);
		if (!res.ok) return [];
		const body = await res.text();
		return body.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
	}

	/**
	 * MISP `/events/restSearch`. Returns events as the upstream JSON shape
	 * (`{ Event: { uuid, info, ... } }`); callers that need a flat row should
	 * project before rendering.
	 */
	async searchEvents(opts: {
		type?: string;
		value?: string;
		limit?: number;
		page?: number;
	} = {}): Promise<MispEventEnvelope[]> {
		const res = await fetch(
			`${this.cfg.baseUrl.replace(/\/$/, "")}/events/restSearch`,
			{
				method: "POST",
				headers: {
					"Authorization": this.cfg.apiKey,
					"Accept": "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ returnFormat: "json", ...opts }),
				signal: AbortSignal.timeout(10000),
			},
		);
		if (!res.ok) return [];
		const json = (await res.json().catch(() => null)) as
			| { response?: MispEventEnvelope[] }
			| null;
		return json?.response ?? [];
	}

	/** Sharing groups the authenticated org belongs to. */
	async listSharingGroups(): Promise<HubSharingGroup[]> {
		const res = await fetch(
			`${this.cfg.baseUrl.replace(/\/$/, "")}/sharing_groups`,
			{
				headers: {
					"Authorization": this.cfg.apiKey,
					"Accept": "application/json",
				},
				signal: AbortSignal.timeout(10000),
			},
		);
		if (!res.ok) return [];
		const json = (await res.json().catch(() => null)) as
			| { sharing_groups?: HubSharingGroup[] }
			| null;
		return json?.sharing_groups ?? [];
	}
}

export interface MispEventEnvelope {
	Event: {
		uuid: string;
		info: string;
		date: string;
		timestamp: string;
		orgc_uuid?: string;
		sharing_group_uuid?: string;
		Attribute?: Array<{ type: string; value: string; comment?: string }>;
	};
}

export interface HubSharingGroup {
	uuid: string;
	name: string;
	description?: string;
	role?: string;
}
