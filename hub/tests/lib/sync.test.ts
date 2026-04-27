import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullFromPeer, type InboundPeerRow } from "../../src/lib/sync";
import { makeTestDb, type TestDb } from "../helpers/d1";
import type { Env } from "../../src/types";

let db: TestDb;
let env: Env;

beforeEach(() => {
	db = makeTestDb();
	env = {
		DB: db.d1,
		AI: {} as Ai,
		TRIAGE_QUEUE: { send: async () => {} } as never,
		HUB_ADMIN_KEY: "admin",
		PEER_KEY_TEST: "upstream-key",
	} as Env & Record<string, string>;
	// Seed sharing group + synthetic org.
	db.raw.prepare(`INSERT INTO sharing_groups (uuid, name) VALUES (?, ?)`)
		.run("sg-1", "sg");
	db.raw.prepare(`INSERT INTO orgs (uuid, name, trust) VALUES (?, ?, ?)`)
		.run("synth-org", "peer:test", 0.5);
	db.raw.prepare(`INSERT INTO sharing_group_orgs (sharing_group_uuid, org_uuid) VALUES (?, ?)`)
		.run("sg-1", "synth-org");
	db.raw.prepare(`INSERT INTO peers (uuid, name) VALUES (?, ?)`).run("peer-1", "test");
	db.raw
		.prepare(
			`INSERT INTO inbound_peers
			 (uuid, peer_uuid, base_url, api_key_secret_name, synthetic_org_uuid,
			  default_sharing_group_uuid)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run("ib-1", "peer-1", "https://upstream.test", "PEER_KEY_TEST", "synth-org", "sg-1");
});

afterEach(() => {
	db.close();
	vi.unstubAllGlobals();
});

function getPeer(): InboundPeerRow {
	return db.raw
		.prepare(`SELECT * FROM inbound_peers WHERE uuid = 'ib-1'`)
		.get() as InboundPeerRow;
}

function mockUpstream(pages: Array<unknown[]>) {
	let call = 0;
	const fetchMock = vi.fn(async () => {
		const events = pages[call] ?? [];
		call++;
		return new Response(JSON.stringify({ response: events }), {
			status: 200, headers: { "Content-Type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const sampleEvent = (uuid: string, ts: string, attrs: Array<{ type: string; value: string }> = [
	{ type: "url", value: `https://bad.example/${uuid}` },
]) => ({
	Event: {
		uuid, info: `evt ${uuid}`, date: "2026-04-26", timestamp: ts,
		analysis: "0", threat_level_id: "2", distribution: "1",
		orgc_uuid: "upstream-org",
		Attribute: attrs.map((a) => ({
			uuid: crypto.randomUUID(), type: a.type, category: "Network activity",
			value: a.value, to_ids: 1,
		})),
	},
});

describe("pullFromPeer", () => {
	it("inserts events, attributes, applies corroboration, advances watermark", async () => {
		mockUpstream([
			[sampleEvent("11111111-1111-1111-1111-111111111111", "1700000000")],
			[],
		]);
		const result = await pullFromPeer(env, getPeer());
		expect(result.events_pulled).toBe(1);
		expect(result.error).toBeNull();

		const ev = db.raw.prepare(`SELECT source_peer_uuid FROM events WHERE uuid = ?`)
			.get("11111111-1111-1111-1111-111111111111") as { source_peer_uuid: string };
		expect(ev.source_peer_uuid).toBe("ib-1");

		const corr = db.raw.prepare(
			`SELECT score, contributor_count FROM corroboration
			 WHERE attribute_type = 'url' AND value = 'https://bad.example/11111111-1111-1111-1111-111111111111'`,
		).get() as { score: number; contributor_count: number };
		expect(corr.score).toBeCloseTo(0.5, 5);
		expect(corr.contributor_count).toBe(1);

		const after = getPeer();
		expect(after.last_pulled_ts).toBe("1700000000");
	});

	it("is idempotent on re-pull — same event does not double-count", async () => {
		const ev1 = sampleEvent("22222222-2222-2222-2222-222222222222", "1700000100");
		mockUpstream([[ev1], []]);
		await pullFromPeer(env, getPeer());

		mockUpstream([[ev1], []]);
		await pullFromPeer(env, getPeer());

		const corr = db.raw.prepare(
			`SELECT score, contributor_count FROM corroboration
			 WHERE attribute_type = 'url'`,
		).get() as { score: number; contributor_count: number };
		expect(corr.score).toBeCloseTo(0.5, 5);
		expect(corr.contributor_count).toBe(1);
	});

	it("skips events whose orgc_uuid matches a local org (loop prevention)", async () => {
		db.raw.prepare(`INSERT INTO orgs (uuid, name, trust) VALUES (?, ?, ?)`)
			.run("local-org", "us", 1.0);
		const ev = sampleEvent("33333333-3333-3333-3333-333333333333", "1700000200");
		ev.Event.orgc_uuid = "local-org";
		mockUpstream([[ev], []]);

		const result = await pullFromPeer(env, getPeer());
		expect(result.events_pulled).toBe(0);
		expect(result.events_skipped).toBe(1);
		const count = db.raw.prepare(`SELECT count(*) as n FROM events`).get() as { n: number };
		expect(count.n).toBe(0);
	});

	it("ingests both events when two share a timestamp across pages (>= watermark)", async () => {
		const ev1 = sampleEvent("44444444-4444-4444-4444-444444444444", "1700000300", [
			{ type: "url", value: "https://a.example" },
		]);
		const ev2 = sampleEvent("55555555-5555-5555-5555-555555555555", "1700000300", [
			{ type: "url", value: "https://b.example" },
		]);
		mockUpstream([[ev1], [ev2], []]);
		const result = await pullFromPeer(env, getPeer());
		expect(result.events_pulled).toBe(2);

		mockUpstream([[ev1, ev2], []]);
		await pullFromPeer(env, getPeer());
		const corrA = db.raw.prepare(
			`SELECT contributor_count FROM corroboration WHERE value = 'https://a.example'`,
		).get() as { contributor_count: number };
		expect(corrA.contributor_count).toBe(1);
	});

	it("drops events excluded by tag_exclude", async () => {
		db.raw.prepare(`UPDATE inbound_peers SET tag_exclude = 'tlp:red' WHERE uuid = 'ib-1'`).run();
		const ev = sampleEvent("66666666-6666-6666-6666-666666666666", "1700000400");
		(ev.Event as Record<string, unknown>).Tag = [{ name: "tlp:red" }];
		mockUpstream([[ev], []]);
		const result = await pullFromPeer(env, getPeer());
		expect(result.events_pulled).toBe(0);
		expect(result.events_filtered).toBe(1);
	});

	it("on upstream 500: records last_error, schedules retry, does NOT advance watermark", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("upstream broken", { status: 500 })
		);
		vi.stubGlobal("fetch", fetchMock);

		db.raw.prepare(`UPDATE inbound_peers SET last_pulled_ts = '1699999999' WHERE uuid = 'ib-1'`).run();

		const result = await pullFromPeer(env, getPeer());
		expect(result.error).not.toBeNull();
		const after = getPeer();
		expect(after.last_pulled_ts).toBe("1699999999");
		expect(after.last_error).toMatch(/non-OK|500/);
		expect(after.next_retry_at).toBeTruthy();
	});

	it("re-pull replaces the event row when upstream edits it", async () => {
		const ev = sampleEvent("77777777-7777-7777-7777-777777777777", "1700000500");
		ev.Event.info = "original";
		mockUpstream([[ev], []]);
		await pullFromPeer(env, getPeer());

		ev.Event.info = "edited upstream";
		ev.Event.timestamp = "1700000600";
		mockUpstream([[ev], []]);
		await pullFromPeer(env, getPeer());

		const stored = db.raw.prepare(`SELECT info FROM events WHERE uuid = ?`)
			.get("77777777-7777-7777-7777-777777777777") as { info: string };
		expect(stored.info).toBe("edited upstream");
	});
});

import { runInboundSync } from "../../src/lib/sync";

describe("runInboundSync", () => {
	it("skips peers whose next_retry_at is in the future", async () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		db.raw.prepare(`UPDATE inbound_peers SET next_retry_at = ? WHERE uuid = 'ib-1'`).run(future);
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ response: [] }), { status: 200 })
		);
		vi.stubGlobal("fetch", fetchMock);

		await runInboundSync(env);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips peers with enabled=0", async () => {
		db.raw.prepare(`UPDATE inbound_peers SET enabled = 0 WHERE uuid = 'ib-1'`).run();
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ response: [] }), { status: 200 })
		);
		vi.stubGlobal("fetch", fetchMock);
		await runInboundSync(env);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
