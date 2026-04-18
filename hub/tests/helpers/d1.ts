// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Minimal D1Database shim backed by better-sqlite3 for unit tests.
 *
 * Implements just the prepare/bind/first/all/run surface the hub code
 * uses. This is NOT a general-purpose D1 emulator — do not reuse in
 * production code. It exists so we can exercise the hub's SQL against
 * a real SQLite without spinning up Miniflare for every test.
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";

interface PreparedLike {
	bind(...args: unknown[]): PreparedLike;
	first<T = unknown>(): Promise<T | null>;
	all<T = unknown>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta: { changes: number; last_row_id?: number } }>;
}

export interface TestDb {
	d1: D1Database;
	raw: Database.Database;
	close(): void;
}

const SCHEMA_PATH = resolve(__dirname, "../../migrations/0001_schema.sql");

export function makeTestDb(): TestDb {
	const raw = new Database(":memory:");
	// Cloudflare D1 does NOT enforce foreign keys by default. Match that so
	// tests exercise the same permissive behaviour production code relies on.
	raw.pragma("foreign_keys = OFF");
	const schema = readFileSync(SCHEMA_PATH, "utf-8");
	// better-sqlite3's `exec` runs multiple statements; it is NOT child_process.
	raw.exec(schema);

	const d1 = {
		prepare(sql: string): PreparedLike {
			// better-sqlite3 expects `?N` placeholders to be passed as an
			// object keyed by N (not a positional array, which is only for
			// anonymous `?` markers). Convert the D1-style `bind(v1, v2, ...)`
			// call into the object form so the same ?N can be reused within
			// a single SQL statement without "too many parameters" errors.
			let boundObj: Record<string, unknown> = {};
			const stmt = raw.prepare(sql);
			const api: PreparedLike = {
				bind(...args: unknown[]) {
					boundObj = {};
					args.forEach((v, i) => {
						boundObj[String(i + 1)] = normalizeBindValue(v);
					});
					return api;
				},
				async first<T = unknown>() {
					return (stmt.get(boundObj) as T | undefined) ?? null;
				},
				async all<T = unknown>() {
					return { results: stmt.all(boundObj) as T[] };
				},
				async run() {
					const info = stmt.run(boundObj);
					return {
						meta: {
							changes: info.changes,
							last_row_id: Number(info.lastInsertRowid),
						},
					};
				},
			};
			return api;
		},
	} as unknown as D1Database;

	return { d1, raw, close: () => raw.close() };
}

/**
 * better-sqlite3 rejects `undefined` bindings (they must be `null` to map to
 * SQL NULL). D1 accepts either; normalise so call sites can be ergonomic.
 */
function normalizeBindValue(v: unknown): unknown {
	if (v === undefined) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	return v;
}
