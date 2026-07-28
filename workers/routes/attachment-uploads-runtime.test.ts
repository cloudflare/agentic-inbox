import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const MAILBOX_ID = "team@example.com";

function field(value: unknown, key: string): unknown {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return Reflect.get(value, key);
}

test(
	"authenticated concurrent attachment uploads converge on one real R2 winner",
	{ timeout: 30_000 },
	async () => {
		const outputDirectory = await mkdtemp(join(tmpdir(), "mail-attachment-upload-"));
		let runtime: Miniflare | undefined;
		try {
			await execFileAsync(
				join(ROOT, "node_modules/.bin/wrangler"),
				[
					"deploy",
					"workers/testing/attachment-upload-integration-entry.ts",
					"--dry-run",
					"--outdir",
					outputDirectory,
					"--compatibility-date",
					"2025-11-28",
					"--compatibility-flag",
					"nodejs_compat",
					"--config",
					"wrangler.jsonc",
					"--env=",
					"--upload-source-maps=false",
				],
				{
					cwd: ROOT,
					env: {
						...process.env,
						WRANGLER_LOG_PATH: join(outputDirectory, "wrangler.log"),
					},
				},
			);
			const bundle = await readFile(
				join(outputDirectory, "attachment-upload-integration-entry.js"),
				"utf8",
			);
			const miniflare = new Miniflare({
				log: new Log(LogLevel.ERROR),
				modules: true,
				script: bundle,
				compatibilityDate: "2025-11-28",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: {
					MAILBOX: {
						className: "AttachmentUploadTestMailboxDO",
						useSQLite: true,
					},
				},
				r2Buckets: ["BUCKET"],
				d1Databases: ["DB"],
				kvNamespaces: ["OAUTH_KV"],
				bindings: {
					BRAND: "wiser",
					FEATURES: [],
					DOMAINS: "wiserchat.ai",
					EMAIL_ADDRESSES: [],
					AWS_REGION: "eu-west-2",
					SES_CONFIGURATION_SET: "mail-portal-events",
					AI_MODEL: "test",
					AI_CHEAP_MODEL: "test",
					AI_STRONG_MODEL: "test",
					AI_COST_ALERT_USD: "25",
					AI_COST_REVIEW_USD: "50",
					VAPID_SUBJECT: "mailto:test@example.com",
				},
			});
			runtime = miniflare;
			const database = await miniflare.getD1Database("DB");
			await database.prepare(
				"CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL, mailbox_address TEXT NOT NULL UNIQUE, mcp_token_hash TEXT, session_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
			).run();
			await database.prepare(
				"CREATE TABLE mailboxes (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, type TEXT NOT NULL, owner_user_id TEXT, is_active INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
			).run();
			await database.prepare(
				"CREATE TABLE mailbox_memberships (mailbox_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (mailbox_id, user_id))",
			).run();
			const now = Date.now();
			await database.prepare(
				"INSERT INTO users (id,email,password_hash,password_salt,role,is_active,mailbox_address,session_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
			).bind(
				"member",
				"member@example.com",
				"hash",
				"salt",
				"AGENT",
				1,
				"member@example.com",
				1,
				now,
				now,
			).run();
			await database.prepare(
				"INSERT INTO users (id,email,password_hash,password_salt,role,is_active,mailbox_address,session_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
			).bind(
				"nonmember",
				"nonmember@example.com",
				"hash",
				"salt",
				"AGENT",
				1,
				"nonmember@example.com",
				1,
				now,
				now,
			).run();
			await database.prepare(
				"INSERT INTO users (id,email,password_hash,password_salt,role,is_active,mailbox_address,session_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
			).bind(
				"admin",
				"admin@example.com",
				"hash",
				"salt",
				"ADMIN",
				1,
				"admin@example.com",
				1,
				now,
				now,
			).run();
			for (const mailbox of [MAILBOX_ID, "other@example.com"]) {
				await database.prepare(
					"INSERT INTO mailboxes (id,address,type,owner_user_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
				).bind(mailbox, mailbox, "SHARED", null, 1, now, now).run();
			}
			await database.prepare(
				"INSERT INTO mailbox_memberships (mailbox_id,user_id,created_at) VALUES (?,?,?)",
			).bind(MAILBOX_ID, "member", now).run();
			const bucket = await miniflare.getR2Bucket("BUCKET");
			for (const mailbox of [MAILBOX_ID, "other@example.com"]) {
				await bucket.put(`mailboxes/${mailbox}.json`, "{}");
			}

			const upload = (
				mailbox: string,
				uploadId: string,
				bytes: Uint8Array,
				user?: "member" | "nonmember" | "admin",
			) => miniflare.dispatchFetch(
				`http://attachment.test/api/v1/mailboxes/${encodeURIComponent(mailbox)}/attachment-uploads/${uploadId}?filename=brief.txt&type=text%2Fplain`,
				{
					method: "PUT",
					headers: user ? { "x-test-user": user } : undefined,
					body: bytes,
				},
			);

			const deniedId = crypto.randomUUID();
			assert.equal((await upload(MAILBOX_ID, deniedId, new Uint8Array([1]))).status, 401);
			assert.equal(
				(await upload(MAILBOX_ID, deniedId, new Uint8Array([1]), "nonmember")).status,
				403,
			);
			assert.equal(
				(await upload("other@example.com", deniedId, new Uint8Array([1]), "member")).status,
				403,
			);
			assert.equal((await bucket.head(`uploads/${MAILBOX_ID}/${deniedId}`)), null);
			assert.equal((await bucket.head(`uploads/other@example.com/${deniedId}`)), null);

			const adminId = crypto.randomUUID();
			assert.equal(
				(await upload("other@example.com", adminId, new Uint8Array([9]), "admin")).status,
				201,
			);
			assert.notEqual(await bucket.head(`uploads/other@example.com/${adminId}`), null);

			const canonicalMailboxId = crypto.randomUUID();
			const canonicalMailbox = await miniflare.dispatchFetch(
				`http://attachment.test/api/v1/mailboxes/TEAM%40EXAMPLE.COM/attachment-uploads/${canonicalMailboxId}?filename=brief.txt&type=text%2Fplain`,
				{ method: "PUT", headers: { "x-test-user": "member" }, body: new Uint8Array([7]) },
			);
			assert.equal(canonicalMailbox.status, 201);
			assert.ok(await bucket.head(`uploads/${MAILBOX_ID}/${canonicalMailboxId}`));
			assert.equal(await bucket.head(`uploads/TEAM@EXAMPLE.COM/${canonicalMailboxId}`), null);

			const doubleEncodedId = crypto.randomUUID();
			const doubleEncoded = await miniflare.dispatchFetch(
				`http://attachment.test/api/v1/mailboxes/team%2540example.com/attachment-uploads/${doubleEncodedId}?filename=brief.txt&type=text%2Fplain`,
				{ method: "PUT", headers: { "x-test-user": "member" }, body: new Uint8Array([8]) },
			);
			assert.equal(doubleEncoded.status, 400);
			assert.equal(await bucket.head(`uploads/${MAILBOX_ID}/${doubleEncodedId}`), null);
			assert.equal(await bucket.head(`uploads/team%40example.com/${doubleEncodedId}`), null);

			const identicalId = crypto.randomUUID();
			const identicalBytes = new TextEncoder().encode("same payload");
			const identical = await Promise.all([
				upload(MAILBOX_ID, identicalId, identicalBytes, "member"),
				upload(MAILBOX_ID, identicalId, identicalBytes, "member"),
			]);
			assert.deepEqual(identical.map((response) => response.status).sort(), [200, 201]);
			const identicalBodies: unknown[] = await Promise.all(
				identical.map((response) => response.json()),
			);
			for (const body of identicalBodies) {
				assert.equal(field(body, "uploadId"), identicalId);
			}
			assert.deepEqual(
				identicalBodies.map((body) => field(body, "replayed")).sort(),
				[false, true],
			);
			assert.equal(
				(await bucket.list({ prefix: `uploads/${MAILBOX_ID}/${identicalId}` })).objects.length,
				1,
			);

			const conflictingId = crypto.randomUUID();
			const left = new TextEncoder().encode("left winner");
			const right = new TextEncoder().encode("right winner");
			const conflicting = await Promise.all([
				upload(MAILBOX_ID, conflictingId, left, "member"),
				upload(MAILBOX_ID, conflictingId, right, "member"),
			]);
			assert.deepEqual(conflicting.map((response) => response.status).sort(), [201, 409]);
			const conflict = conflicting.find((response) => response.status === 409);
			assert.ok(conflict);
			const conflictBody: unknown = await conflict.json();
			assert.equal(field(conflictBody, "code"), "attachment_upload_conflict");
			const winner = await bucket.get(`uploads/${MAILBOX_ID}/${conflictingId}`);
			assert.ok(winner);
			const winnerText = await winner.text();
			assert.ok(winnerText === "left winner" || winnerText === "right winner");

			let bodyRequestedResolve: (() => void) | undefined;
			const bodyRequested = new Promise<void>((resolve) => { bodyRequestedResolve = resolve; });
			let releaseBody: (() => void) | undefined;
			const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
			let emitted = false;
			const revokedId = crypto.randomUUID();
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (emitted) return;
					emitted = true;
					bodyRequestedResolve?.();
					await bodyGate;
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.close();
				},
			});
			const inFlight = miniflare.dispatchFetch(
				`http://attachment.test/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachment-uploads/${revokedId}?filename=brief.txt&type=text%2Fplain`,
				{
					method: "PUT",
					headers: { "x-test-user": "member" },
					body,
					duplex: "half",
				} as RequestInit & { duplex: "half" },
			);
			await bodyRequested;
			await database.prepare(
				"DELETE FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = ?",
			).bind(MAILBOX_ID, "member").run();
			releaseBody?.();
			assert.equal((await inFlight).status, 403);
			assert.equal(await bucket.head(`uploads/${MAILBOX_ID}/${revokedId}`), null);
			const afterRevocationId = crypto.randomUUID();
			assert.equal(
				(await upload(MAILBOX_ID, afterRevocationId, new Uint8Array([1]), "member")).status,
				403,
			);
			assert.equal(await bucket.head(`uploads/${MAILBOX_ID}/${afterRevocationId}`), null);
		} finally {
			await runtime?.dispose();
			await rm(outputDirectory, { recursive: true, force: true });
		}
	},
);
