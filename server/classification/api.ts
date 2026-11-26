import type { KeyVariables } from "../api-keys";
import { reapplyApi } from "./reapply";
import { providerStateApi } from "./provider-state-api";
import { classifierHealth } from "./provider-state";
import { backfillsApi } from "./backfills";
import { inspectClassifications } from "./inspect";
import { reviewInput, reviewClassification } from "./review";
import { decisionRulesSchema } from "../../shared/decision-rules";
import { rerunApi } from "./rerun-api";
import { examplesApi } from "./examples-api";
import { classifierTestApi } from "./test-api";
import { providerRunsApi } from "./provider-runs-api";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
import type postgres from "postgres";
import { finishRuns } from "./queue";
const runInput = z
	.object({
		mailbox_ids: z.array(z.string().email()).min(1).max(50),
		selection: z.enum(["unprocessed", "all"]),
		reset: z.boolean().default(false),
		enable: z.boolean().default(false),
		received_from: z.string().datetime().optional(),
		received_before: z.string().datetime().optional(),
		limit: z.number().int().min(1).max(5000).default(5000),
	})
	.strict();
function validateRunRange(data: z.infer<typeof runInput>) {
	if (
		data.received_from &&
		data.received_before &&
		data.received_from >= data.received_before
	)
		throw new HTTPException(400, {
			message: "The end date must not be before the start date",
		});
	if (data.reset && data.selection !== "all")
		throw new HTTPException(400, {
			message: "Choose all conversations to reset corrections",
		});
}
function runTargets(
	sql: Database | postgres.TransactionSql,
	data: z.infer<typeof runInput>,
	classifierId: string,
	revision: number,
	lock = false,
) {
	return sql`SELECT c.mailbox_id,c.thread_id,c.generation FROM conversations c
	CROSS JOIN LATERAL (SELECT max(e.date) AS received_at FROM emails e WHERE e.mailbox_id=c.mailbox_id AND e.thread_id=c.thread_id AND e.delivery_status='received') latest
	WHERE c.mailbox_id IN ${sql(data.mailbox_ids)} AND classifier_thread_active(c.mailbox_id,c.thread_id)
	${data.received_from ? sql`AND latest.received_at>=${data.received_from}::timestamptz` : sql``}
	${data.received_before ? sql`AND latest.received_at<${data.received_before}::timestamptz` : sql``}
	AND (${data.selection === "all"} OR NOT EXISTS(SELECT 1 FROM conversation_classifications j WHERE j.classifier_id=${classifierId} AND j.mailbox_id=c.mailbox_id AND j.thread_id=c.thread_id AND j.revision=${revision} AND j.generation=c.generation AND j.status IN ('complete','review','pending')))
	ORDER BY latest.received_at DESC,c.mailbox_id,c.thread_id LIMIT ${data.limit} ${lock ? sql`FOR UPDATE OF c` : sql``}`;
}
const id = z.string().uuid();
const input = z
	.object({
		question: z.string().trim().min(1).max(4000),
		tag_id: id,
		mailbox_ids: z.array(z.string().email()).max(50),
		enabled: z.boolean(),
		include_reviewed_examples: z.boolean().optional(),
		decision_rules: decisionRulesSchema.optional(),
		revision: z.number().int().positive().optional(),
	})
	.strict();
const fail = (status: 400 | 403 | 404 | 409, message: string): never => {
	throw new HTTPException(status, { message });
};
export function classifierApi(
	db: Database,
	options: {
		enabled: boolean;
		admin: boolean;
		actor: string;
		kick?: (tokens?: string[]) => void;
		key?: string;
		transport?: typeof fetch;
	},
) {
	const app = new Hono<{ Variables: KeyVariables }>();
	app.use("*", async (c, next) => {
		if (!options.enabled)
			return c.json({ error: "Classifiers are not enabled" }, 503);
		if (
			c.req.method !== "GET" &&
			!c.req.path.includes("/results/") &&
			!options.admin &&
			!c.get("apiKey")?.permissions.includes("classifications:run")
		)
			return c.json(
				{ error: "Only inbox administrators can configure or run classifiers" },
				403,
			);
		await next();
	});
	app.get("/health", async (c) => c.json(await classifierHealth(db)));
	app.route("/reapply-rules", reapplyApi(db, options.actor));
	app.get("/threads/:mailbox/:thread/classifications", async (c) =>
		c.json(
			await inspectClassifications(
				db,
				c.req.param("mailbox"),
				id.parse(c.req.param("thread")),
			),
		),
	);
	app.route(
		"/provider-state",
		providerStateApi(db, options.key, options.transport, options.kick),
	);
	app.route("/backfills", backfillsApi(db, options.kick, options.actor));
	app.route("/", rerunApi(db, options.admin, options.kick));
	app.route("/examples", examplesApi(db, options.admin, options.actor));
	app.route("/", classifierTestApi(db, options.key, options.transport));
	app.route("/provider-runs", providerRunsApi(db, options.admin));
	app.get("/classifiers", async (c) => {
		await finishRuns(db);
		return c.json(
			await db`SELECT c.*,to_json(c.mailbox_ids) AS mailbox_ids,t.name,t.color,t.group_id,
   (SELECT row_to_json(s) FROM (SELECT r.id,r.status,r.created_at,count(i.*)::int AS total,
     count(*) FILTER(WHERE i.status IN ('complete','review'))::int AS processed,
     count(*) FILTER(WHERE i.status='review')::int AS review,
     count(*) FILTER(WHERE i.status='failed')::int AS failed,
     count(*) FILTER(WHERE i.status='skipped')::int AS skipped
    FROM classifier_runs r LEFT JOIN classifier_run_items i ON i.run_id=r.id WHERE r.classifier_id=c.id GROUP BY r.id ORDER BY r.created_at DESC LIMIT 1) s) AS run,
   (SELECT count(*)::int FROM conversation_classifications j WHERE j.classifier_id=c.id AND j.status='error') AS errors
   FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.archived_at IS NULL ORDER BY c.updated_at,c.id`,
		);
	});
	async function save(classifierId: string | null, body: unknown) {
		const data = input.parse(body);
		return db.begin(async (tx) => {
			const [tag] =
				await tx`SELECT name,color,group_id FROM tags WHERE id=${data.tag_id} AND archived_at IS NULL`;
			if (!tag) fail(404, "Tag not found");
			if (tag.group_id)
				fail(
					409,
					"Manage this classifier through Settings → Tags → its group.",
				);
			if (data.mailbox_ids.length) {
				const found =
					await tx`SELECT id FROM mailboxes WHERE id IN ${tx(data.mailbox_ids)}`;
				if (found.length !== new Set(data.mailbox_ids).size)
					fail(400, "Unknown mailbox");
			}
			const values = {
				question: data.question,
				tag_id: data.tag_id,
				mailbox_ids: [...new Set(data.mailbox_ids)].sort(),
				enabled: data.enabled,
			};
			if (!classifierId) {
				const [{ count }] =
					await tx`SELECT count(*)::int AS count FROM classifiers`;
				if (count >= 50) fail(400, "A maximum of 50 classifiers is supported");
				const [created] =
					await tx`INSERT INTO classifiers(question,tag_id,mailbox_ids,enabled,include_reviewed_examples,decision_rules) VALUES(${values.question},${values.tag_id},ARRAY(SELECT jsonb_array_elements_text(${tx.json(values.mailbox_ids)})),${values.enabled},${data.include_reviewed_examples ?? false},${tx.json(data.decision_rules ?? {})}) RETURNING *,to_json(mailbox_ids) AS mailbox_ids`;
				return { ...created, ...tag, run: null };
			}
			const [old] =
				await tx`SELECT *,to_json(mailbox_ids) AS mailbox_ids FROM classifiers WHERE id=${classifierId} FOR UPDATE`;
			if (!old) fail(404, "Classifier not found");
			const [managed] =
				await tx`SELECT 1 FROM tags WHERE id=${old.tag_id} AND group_id IS NOT NULL`;
			if (managed)
				fail(
					409,
					"Manage this classifier through Settings → Tags → its group.",
				);
			if (data.revision !== old.revision)
				fail(409, "Classifier changed; refresh and try again");
			if (old.question !== data.question || old.tag_id !== data.tag_id)
				await tx`DELETE FROM classifier_examples WHERE classifier_id=${classifierId}`;
			const changed =
				(data.include_reviewed_examples ?? old.include_reviewed_examples) !==
					old.include_reviewed_examples ||
				old.question !== data.question ||
				old.tag_id !== data.tag_id ||
				JSON.stringify([...old.mailbox_ids].sort()) !==
					JSON.stringify(values.mailbox_ids);
			if (changed || old.enabled !== data.enabled) {
				await tx`UPDATE classifier_runs SET status='cancelled' WHERE classifier_id=${classifierId} AND status='running'`;
				await tx`DELETE FROM conversation_classifications WHERE classifier_id=${classifierId}`;
				await tx`DELETE FROM conversation_tags WHERE tag_id=${old.tag_id} AND source='classifier'`;
			}
			const [updated] =
				await tx`UPDATE classifiers SET decision_rules=${tx.json(data.decision_rules ?? old.decision_rules)},question=${values.question},tag_id=${values.tag_id},mailbox_ids=ARRAY(SELECT jsonb_array_elements_text(${tx.json(values.mailbox_ids)})),enabled=${values.enabled},include_reviewed_examples=${data.include_reviewed_examples ?? old.include_reviewed_examples},revision=revision+${changed || old.enabled !== data.enabled ? 1 : 0},updated_at=now() WHERE id=${classifierId} RETURNING *,to_json(mailbox_ids) AS mailbox_ids`;
			// Enabling does not implicitly classify historical mail. Preserve existing jobs on a no-op edit.
			// Unchanged settings retain both the evaluation version and queued tokens.
			return { ...updated, ...tag, run: null };
		});
	}
	app.post("/classifiers", async (c) =>
		c.json(await save(null, await c.req.json()), 201),
	);
	app.put("/classifiers/:id", async (c) =>
		c.json(await save(id.parse(c.req.param("id")), await c.req.json())),
	);
	app.post("/runs/preview", async (c) => {
		const input = runInput
			.extend({ classifier_ids: z.array(id).min(1).max(100) })
			.parse(await c.req.json());
		validateRunRange(input);
		const conversations = new Set<string>();
		const counts: Record<string, number> = {};
		for (const classifierId of input.classifier_ids) {
			const [classifier] =
				await db`SELECT c.revision,to_json(c.mailbox_ids) AS mailbox_ids FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE c.id=${classifierId} AND t.archived_at IS NULL`;
			if (!classifier) fail(404, "Classifier not found");
			if (
				classifier.mailbox_ids.length &&
				input.mailbox_ids.some((m) => !classifier.mailbox_ids.includes(m))
			)
				fail(400, "Mailboxes must be within classifier scope");
			const targets = await runTargets(
				db,
				input,
				classifierId,
				classifier.revision,
			);
			counts[classifierId] = targets.length;
			for (const target of targets)
				conversations.add(
					JSON.stringify([target.mailbox_id, target.thread_id]),
				);
		}
		return c.json({ count: conversations.size, counts });
	});
	app.post("/classifiers/:id/runs", async (c) => {
		const classifierId = id.parse(c.req.param("id"));
		const data = runInput.parse(await c.req.json());
		validateRunRange(data);
		const run = await db.begin(async (tx) => {
			const [classifier] =
				await tx`SELECT *,to_json(mailbox_ids) AS mailbox_ids FROM classifiers WHERE id=${classifierId} FOR UPDATE`;
			if (!classifier) fail(404, "Classifier not found");
			const [tag] =
				await tx`SELECT group_id,archived_at FROM tags WHERE id=${classifier.tag_id}`;
			if (!tag || tag.archived_at) fail(404, "Classifier tag not found");
			if (tag.group_id && data.enable && !classifier.enabled)
				fail(400, "Enable automatic classification in its tag group first");
			const [active] =
				await tx`SELECT * FROM classifier_runs WHERE classifier_id=${classifierId} AND status='running'`;
			if (active) return active;
			if (
				classifier.mailbox_ids.length &&
				data.mailbox_ids.some((m) => !classifier.mailbox_ids.includes(m))
			)
				fail(400, "Mailboxes must be within classifier scope");
			const targets = await runTargets(
				tx,
				data,
				classifierId,
				classifier.revision,
				true,
			);
			if (!targets.length) fail(400, "No conversations to process");
			if (data.enable)
				await tx`UPDATE classifiers SET enabled=true WHERE id=${classifierId}`;
			const [created] =
				await tx`INSERT INTO classifier_runs(classifier_id,revision,actor) VALUES(${classifierId},${classifier.revision},${options.actor}) RETURNING *`;
			await tx`INSERT INTO classifier_run_items(run_id,mailbox_id,thread_id,status)
    SELECT ${created.id},t.mailbox_id,t.thread_id,CASE WHEN tag_manually_overridden(t.mailbox_id,t.thread_id,${classifier.tag_id}) OR (${!data.reset} AND EXISTS(SELECT 1 FROM conversation_classifications j WHERE j.mailbox_id=t.mailbox_id AND j.thread_id=t.thread_id AND j.classifier_id=${classifierId} AND j.source IN ('human','agent'))) THEN 'skipped' ELSE 'pending' END
    FROM jsonb_to_recordset(${tx.json(targets)}) AS t(mailbox_id text,thread_id uuid,generation integer)`;
			await tx`INSERT INTO conversation_classifications(mailbox_id,thread_id,classifier_id,revision,generation,run_id,priority)
    SELECT i.mailbox_id,i.thread_id,${classifierId},${classifier.revision},c.generation,${created.id},2 FROM classifier_run_items i JOIN conversations c USING(mailbox_id,thread_id) WHERE i.run_id=${created.id} AND i.status='pending'
    ON CONFLICT(mailbox_id,thread_id,classifier_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,run_id=excluded.run_id,priority=2,status='pending',token=gen_random_uuid(),answer=NULL,probability=NULL,source='jev',actor=NULL,error=NULL,attempts=0,available_at=now(),lease_until=NULL,updated_at=now()`;
			await tx`DELETE FROM conversation_tags ct USING classifier_run_items i WHERE i.run_id=${created.id} AND i.status='pending' AND ct.mailbox_id=i.mailbox_id AND ct.thread_id=i.thread_id AND ct.tag_id=${classifier.tag_id} AND ct.source='classifier'`;
			return created;
		});
		options.kick?.();
		return c.json(run, 201);
	});
	app.post("/classifiers/:id/cancel", async (c) => {
		const classifierId = id.parse(c.req.param("id"));
		await db.begin(async (tx) => {
			await tx`SELECT id FROM classifiers WHERE id=${classifierId} FOR UPDATE`;
			const runs =
				await tx`UPDATE classifier_runs SET status='cancelled' WHERE classifier_id=${classifierId} AND status='running' RETURNING id`;
			for (const run of runs) {
				await tx`UPDATE conversation_classifications SET status=CASE WHEN priority=0 THEN status ELSE 'skipped' END,run_id=NULL,token=gen_random_uuid(),lease_until=NULL WHERE run_id=${run.id} AND status='pending'`;
				await tx`UPDATE classifier_run_items SET status='skipped' WHERE run_id=${run.id} AND status='pending'`;
			}
		});
		return c.body(null, 204);
	});
	app.get("/results/:mailbox", async (c) => {
		const thread = c.req.query("thread");
		if (thread) id.parse(thread);
		const threads = c.req.query("threads");
		const threadIds =
			threads === undefined
				? undefined
				: z.array(id).min(1).max(100).parse(threads.split(","));
		const rows =
			await db`SELECT j.mailbox_id,j.thread_id,j.classifier_id,j.revision,j.generation,j.token,j.status,j.answer,j.probability,j.source,j.error,(j.revision<>c.revision OR j.generation<>v.generation) AS needs_reevaluation,c.decision_rules,c.question,t.name,t.color,t.id AS tag_id,t.group_id,g.name AS group_name,g.selection AS group_selection,g.instructions AS group_instructions,log.response_body,log.question_key FROM conversation_classifications j JOIN conversations v USING(mailbox_id,thread_id) JOIN classifiers c ON c.id=j.classifier_id JOIN tags t ON t.id=c.tag_id LEFT JOIN tag_groups g ON g.id=t.group_id LEFT JOIN LATERAL (
 SELECT r.response_body,i.question_key FROM classifier_provider_run_items i JOIN classifier_provider_runs r ON r.id=i.run_id
 WHERE i.job_token=j.token AND i.classifier_id=j.classifier_id AND r.mailbox_id=j.mailbox_id AND r.thread_id=j.thread_id
 ORDER BY r.started_at DESC,r.id DESC LIMIT 1
 ) log ON g.selection IN ('single','score') WHERE j.mailbox_id=${c.req.param("mailbox")} AND (c.enabled OR j.priority=2) AND t.archived_at IS NULL AND j.status IN ('review','error') ${thread ? db`AND j.thread_id=${thread}` : db``} ${threadIds ? db`AND j.thread_id IN ${db(threadIds)}` : db``} AND NOT tag_manually_overridden(j.mailbox_id,j.thread_id,c.tag_id) ORDER BY j.updated_at DESC LIMIT 1000`;
		return c.json(
			rows.map(({ response_body, question_key, ...row }) => {
				let confidence: number | null = null;
				let score: number | null = null;
				try {
					const answer = JSON.parse(response_body)?.answers?.[question_key];
					if (
						(row.group_selection === "single" ||
							row.group_selection === "score") &&
						row.probability != null &&
						(answer?.type === "choice" || answer?.type === "score") &&
						typeof answer.confidence === "number" &&
						Number.isFinite(answer.confidence) &&
						answer.confidence >= 0 &&
						answer.confidence <= 1
					) {
						confidence = answer.confidence;
						if (
							answer.type === "score" &&
							typeof answer.score === "number" &&
							Number.isFinite(answer.score)
						)
							score = answer.score;
					}
				} catch {
					/* Failed or historical requests may have no valid answer. */
				}
				return { ...row, confidence, score };
			}),
		);
	});
	app.put("/results/:mailbox/:thread/:classifier", async (c) => {
		const classifierId = id.parse(c.req.param("classifier")),
			thread = id.parse(c.req.param("thread")),
			mailbox = c.req.param("mailbox");
		const data = reviewInput.parse(await c.req.json());
		await db.begin(async (tx) => {
			await reviewClassification(
				tx as unknown as Database,
				mailbox,
				thread,
				classifierId,
				data,
				c.get("apiKey") ? `api-key:${c.get("apiKey")!.id}` : options.actor,
				c.get("apiKey") ? "agent" : "human",
			);
		});
		return c.body(null, 204);
	});
	return app;
}
