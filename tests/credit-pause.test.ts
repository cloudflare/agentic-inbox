import { before, beforeEach, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { classifierApi } from "../server/classification/api";
import { processJob } from "../server/classification/queue";
import {
	creditGuard,
	creditsPaused,
	JevCreditPaused,
} from "../server/classification/provider-state";
import {
	consumeBatch,
	publishOutbox,
	queueNames,
} from "../server/classification/dispatch";
const schema = "test_credit_pause_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db);
const mailbox = "credits@example.test",
	other = "other@example.test";
let classifier: string;
let calls = 0,
	kicks = 0;
const yes: typeof fetch = async () =>
	Response.json({
		model: "jev-test",
		answers: { match: { type: "noul", noul: 0.99 } },
	});
let provider: typeof fetch = yes;
const app = classifierApi(db, {
	enabled: true,
	admin: true,
	actor: "test",
	key: "test",
	transport: (...args) => {
		calls++;
		return provider(...args);
	},
	kick: () => {
		kicks++;
	},
});
const call = (path: string, method = "GET") =>
	app.request("http://localhost" + path, { method });
async function email(m = mailbox) {
	const e = await store.insert(m, {
		sender: "person@example.test",
		recipient: m,
		subject: "Help",
		body: "Please reply",
		folder_id: "inbox",
		date: new Date(),
	});
	assert.ok(e?.thread_id);
	const [job] =
		await db`SELECT * FROM conversation_classifications WHERE mailbox_id=${m} AND thread_id=${e.thread_id} AND classifier_id=${classifier}`;
	return job;
}
async function pause() {
	await creditGuard(db, async () =>
		Response.json({ error: "credit exhausted" }, { status: 402 }),
	)("https://example.test");
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Credits");
	await store.createMailbox(other, "Other");
	await db`UPDATE classifiers SET enabled=false`;
	const [tag] =
		await db`INSERT INTO tags(name,color) VALUES('Credit test','#123456') RETURNING id`;
	const [c] =
		await db`INSERT INTO classifiers(tag_id,question,enabled) VALUES(${tag.id},'Does this need a reply?',true) RETURNING id`;
	classifier = c.id;
});
beforeEach(async () => {
	await db`DELETE FROM conversation_classifications`;
	await db`DELETE FROM classifier_runs`;
	await db`DELETE FROM emails`;
	await db`DELETE FROM conversations`;
	await db`UPDATE classifier_provider_state SET paused_at=NULL,pause_version=0,resume_token=NULL,resume_until=NULL,resume_error=NULL,cooldown_until=NULL`;
	calls = 0;
	kicks = 0;
	provider = yes;
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
test("402 pauses globally and parks live/backfill deliveries without failing jobs or spending retries", async () => {
	const job = await email();
	await db`UPDATE conversation_classifications SET attempts=3 WHERE token=${job.token}`;
	const [run] =
		await db`INSERT INTO classifier_runs(classifier_id,revision,actor) VALUES(${classifier},1,'test') RETURNING id`;
	await db`INSERT INTO classifier_run_items(run_id,mailbox_id,thread_id) VALUES(${run.id},${mailbox},${job.thread_id})`;
	await db`UPDATE conversation_classifications SET run_id=${run.id} WHERE token=${job.token}`;
	let requests = 0;
	await processJob(db, "test", job.token, async () => {
		requests++;
		return Response.json({ error: "credit exhausted" }, { status: 402 });
	});
	assert.equal(requests, 1);
	assert.equal(await creditsPaused(db), true);
	const [paused] =
		await db`SELECT * FROM conversation_classifications WHERE token=${job.token}`;
	assert.equal(paused.status, "pending");
	assert.equal(paused.attempts, 4);
	assert.equal(paused.credit_pauses, 1);
	assert.equal(paused.lease_id, null);
	assert.equal(
		(
			await db`SELECT status FROM classifier_run_items WHERE run_id=${run.id}`
		)[0].status,
		"pending",
	);
	const next = await email(other);
	let acks = 0;
	await db`UPDATE classifier_outbox SET published_at=now()`;
	for (const queue of [queueNames.live, queueNames.backfill, queueNames.dead])
		await consumeBatch(
			db,
			"test",
			{
				queue,
				messages: [
					{
						body: { version: 2, tokens: [job.token, next.token] },
						ack() {
							acks++;
						},
						retry() {
							assert.fail("Paused deliveries should be parked");
						},
					},
				],
			},
			async () => {
				assert.fail("No provider call while paused");
			},
			4,
		);
	assert.equal(acks, 3);
	assert.equal(
		(
			await db`SELECT attempts FROM conversation_classifications WHERE token=${next.token}`
		)[0].attempts,
		0,
	);
	assert.equal(
		(
			await db`SELECT count(*)::int AS n FROM classifier_outbox WHERE published_at IS NULL`
		)[0].n,
		2,
	);
	assert.equal(
		await publishOutbox(db, {
			live: { sendBatch: async () => assert.fail("No publish") },
			backfill: { sendBatch: async () => assert.fail("No publish") },
		}),
		0,
	);
	const resume = await call("/provider-state/resume", "POST");
	assert.equal(resume.status, 200);
	assert.equal((await resume.json()).paused, false);
	assert.equal(calls, 1);
	assert.equal(kicks, 1);
	await consumeBatch(
		db,
		"test",
		{
			queue: queueNames.live,
			messages: [
				{
					body: { version: 1, token: job.token },
					ack() {},
					retry() {
						assert.fail("Credit pauses cannot exhaust processing retries");
					},
				},
			],
		},
		yes,
		4,
	);
	assert.equal(
		(
			await db`SELECT status FROM conversation_classifications WHERE token=${job.token}`
		)[0].status,
		"complete",
	);
});
test("failed resume keeps queue paused and does not expose real email content to the probe", async () => {
	await pause();
	let payload: unknown;
	provider = async (_url, init) => {
		payload = JSON.parse(String(init?.body));
		return Response.json({}, { status: 402 });
	};
	assert.equal(
		(await (await call("/provider-state/resume", "POST")).json()).paused,
		true,
	);
	assert.equal(calls, 1);
	assert.equal(kicks, 0);
	assert.deepEqual((payload as { state: unknown }).state, { status: "ready" });
	provider = async () => {
		throw Error("network");
	};
	const state = await (await call("/provider-state/resume", "POST")).json();
	assert.equal(state.paused, true);
	assert.equal(state.resume_error, "provider_unavailable");
	provider = async () => Response.json({ answers: {} });
	assert.equal(
		(await (await call("/provider-state/resume", "POST")).json()).paused,
		true,
	);
});
test("concurrent resume clicks send exactly one probe; expired probe leases are recoverable", async () => {
	await pause();
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((r) => (enter = r)),
		wait = new Promise<void>((r) => (release = r));
	provider = async (...args) => {
		enter();
		await wait;
		return yes(...args);
	};
	const first = call("/provider-state/resume", "POST");
	await entered;
	assert.equal((await call("/provider-state/resume", "POST")).status, 409);
	assert.equal(calls, 1);
	release();
	assert.equal((await (await first).json()).paused, false);
	// Already active is an idempotent no-op.
	await call("/provider-state/resume", "POST");
	assert.equal(calls, 1);
	await pause();
	await db`UPDATE classifier_provider_state SET resume_until=now()-interval '1 second',resume_token=gen_random_uuid()`;
	provider = yes;
	assert.equal(
		(await (await call("/provider-state/resume", "POST")).json()).paused,
		false,
	);
	assert.equal(calls, 2);
});
test("a later in-flight 402 fences a successful probe and keeps the queue paused", async () => {
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((r) => (enter = r)),
		wait = new Promise<void>((r) => (release = r));
	const inflight = creditGuard(db, async () => {
		enter();
		await wait;
		return Response.json({}, { status: 402 });
	})("https://example.test");
	await entered;
	await pause();
	provider = async (...args) => {
		release();
		await inflight;
		return yes(...args);
	};
	const state = await (await call("/provider-state/resume", "POST")).json();
	assert.equal(state.paused, true);
	assert.equal(state.checking, false);
	assert.equal(kicks, 0);
});
test("blocked HTTP calls, manual tests and direct job processing cannot bypass the pause", async () => {
	const job = await email();
	await pause();
	await assert.rejects(
		creditGuard(db, async () => assert.fail("No request"))(
			"https://example.test",
		),
		JevCreditPaused,
	);
	await processJob(db, "test", job.token, async () =>
		assert.fail("No request"),
	);
	const response = await app.request("http://localhost/test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mailbox_id: mailbox,
			thread_id: job.thread_id,
			questions: [{ name: "Test", question: "Does this need a reply?" }],
			execute: true,
		}),
	});
	assert.equal(response.status, 200);
	assert.equal(
		(await response.json()).results[0].error,
		"provider_credit_paused",
	);
	assert.equal(calls, 0);
});
test("rate limits and server failures retain automatic retries instead of pausing billing", async () => {
	for (const status of [429, 503]) {
		const job = await email();
		const result = await processJob(db, "test", job.token, async () =>
			Response.json({}, { status }),
		);
		assert.ok("retry" in result);
		assert.equal(await creditsPaused(db), false);
		await db`UPDATE classifier_provider_state SET cooldown_until=NULL`;
	}
});
test("resume requires administrator access and token replacement resets the excluded retry count", async () => {
	await pause();
	const member = classifierApi(db, {
		enabled: true,
		admin: false,
		actor: "member",
		key: "test",
		transport: async () => assert.fail("Forbidden"),
	});
	assert.equal(
		(
			await member.request("http://localhost/provider-state/resume", {
				method: "POST",
			})
		).status,
		403,
	);
	const job = await email();
	await db`UPDATE conversation_classifications SET credit_pauses=2 WHERE token=${job.token}`;
	const [replacement] =
		await db`UPDATE conversation_classifications SET token=gen_random_uuid(),attempts=0 WHERE token=${job.token} RETURNING credit_pauses`;
	assert.equal(replacement.credit_pauses, 0);
});

test("an expired probe cannot clear a newer failed check", async () => {
	await pause();
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>((r) => (entered = r)),
		waiting = new Promise<void>((r) => (release = r));
	provider = async (...args) => {
		entered();
		await waiting;
		return yes(...args);
	};
	const old = call("/provider-state/resume", "POST");
	await started;
	await db`UPDATE classifier_provider_state SET resume_until=now()-interval '1 second'`;
	provider = async () => Response.json({}, { status: 402 });
	assert.equal(
		(await (await call("/provider-state/resume", "POST")).json()).paused,
		true,
	);
	release();
	assert.equal((await (await old).json()).paused, true);
	assert.equal(kicks, 0);
});

test("a payment failure in an interactive classifier test also pauses both queues", async () => {
	const job = await email();
	provider = async () => Response.json({}, { status: 402 });
	const response = await app.request("http://localhost/test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mailbox_id: mailbox,
			thread_id: job.thread_id,
			questions: [{ name: "Test", question: "Does this need a reply?" }],
			execute: true,
		}),
	});
	assert.equal(response.status, 200);
	assert.equal((await response.json()).results[0].error, "provider_http_402");
	assert.equal(await creditsPaused(db), true);
	assert.equal(calls, 1);
});
test("health shows the pause and the last successful request, with no mail content, to non-admins", async () => {
	const reader = classifierApi(db, {
		enabled: true,
		admin: false,
		actor: "monitor",
	});
	const health = async () => {
		const res = await reader.request("http://localhost/health");
		assert.equal(res.status, 200);
		return (await res.json()) as Record<string, unknown>;
	};
	await db`DELETE FROM classifier_provider_runs`;
	assert.deepEqual(await health(), {
		paused: false,
		paused_at: null,
		resume_error: null,
		last_classified_at: null,
	});
	const job = await email();
	await processJob(db, "test", job.token, yes);
	const ok = await health();
	assert.deepEqual(Object.keys(ok).sort(), [
		"last_classified_at",
		"paused",
		"paused_at",
		"resume_error",
	]);
	assert.equal(ok.paused, false);
	assert.ok(ok.last_classified_at);
	await pause();
	const paused = await health();
	assert.equal(paused.paused, true);
	assert.ok(paused.paused_at);
	assert.equal(paused.resume_error, "provider_http_402");
	assert.equal(paused.last_classified_at, ok.last_classified_at);
	const text = JSON.stringify(paused);
	for (const secret of ["Help", "Please reply", "person@example.test", mailbox])
		assert.ok(!text.includes(secret), secret);
	assert.equal(
		(await reader.request("http://localhost/health", { method: "POST" }))
			.status,
		403,
	);
});
