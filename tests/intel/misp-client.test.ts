// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MispClient } from "../../workers/intel/misp-client";

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const baseCfg = { baseUrl: "https://hub.example.com", apiKey: "secret" };

function jsonResponse(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

function textResponse(body: string, init: ResponseInit = {}) {
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/plain" },
		...init,
	});
}

describe("MispClient.searchEvents", () => {
	it("POSTs /events/restSearch with the auth header and unwraps `response`", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				response: [{ Event: { uuid: "u1", info: "phish", date: "2026-04-29", timestamp: "1" } }],
			}),
		);
		const client = new MispClient(baseCfg);
		const events = await client.searchEvents({ limit: 5 });

		expect(events).toHaveLength(1);
		expect(events[0].Event.uuid).toBe("u1");

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://hub.example.com/events/restSearch");
		expect((init as RequestInit).method).toBe("POST");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe("secret");
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body).toMatchObject({ returnFormat: "json", limit: 5 });
	});

	it("returns an empty array on non-2xx", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
		const client = new MispClient(baseCfg);
		expect(await client.searchEvents()).toEqual([]);
	});
});

describe("MispClient.listSharingGroups", () => {
	it("GETs /sharing_groups and unwraps `sharing_groups`", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				sharing_groups: [{ uuid: "sg1", name: "Trusted", role: "member" }],
			}),
		);
		const client = new MispClient(baseCfg);
		const groups = await client.listSharingGroups();

		expect(groups).toEqual([{ uuid: "sg1", name: "Trusted", role: "member" }]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://hub.example.com/sharing_groups");
		expect((init as RequestInit).method).toBeUndefined();
	});

	it("returns [] when the hub returns 401", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
		const client = new MispClient(baseCfg);
		expect(await client.listSharingGroups()).toEqual([]);
	});
});

describe("MispClient.fetchDestroyList", () => {
	it("strips comments + blanks and returns ordered values", async () => {
		fetchMock.mockResolvedValue(
			textResponse("# header\nbad.example.com\n\n# group\nbadder.example.com\n"),
		);
		const client = new MispClient(baseCfg);
		const list = await client.fetchDestroyList();
		expect(list).toEqual(["bad.example.com", "badder.example.com"]);
	});

	it("appends ?sharing_group=… when scoped to one group", async () => {
		fetchMock.mockResolvedValue(textResponse(""));
		const client = new MispClient(baseCfg);
		await client.fetchDestroyList({ sharingGroup: "sg-uuid" });
		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://hub.example.com/feeds/destroylist.txt?sharing_group=sg-uuid",
		);
	});

	it("returns [] on 403 and never retries against the unscoped endpoint", async () => {
		// Hub returns 403 when the org isn't a member of the requested
		// sharing group (feeds.ts). The client must not silently widen the
		// request to the unscoped destroylist — that would leak indicators
		// the caller isn't entitled to see.
		fetchMock.mockResolvedValue(textResponse("forbidden", { status: 403 }));
		const client = new MispClient(baseCfg);
		const list = await client.fetchDestroyList({ sharingGroup: "sg-not-a-member" });
		expect(list).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
