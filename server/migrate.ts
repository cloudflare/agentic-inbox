import { readFile } from "node:fs/promises";
import type { Database } from "./db";

export async function migrate(db: Database) {
	for (const [version, filename] of [
		[1, "001_inbox.sql"],
		[2, "002_real_mail.sql"],
		[3, "003_mailbox_creation.sql"],
		[5, "005_conversation_tags.sql"],
		[6, "006_classifiers.sql"],
		[7, "007_classifier_outbox.sql"],
		[8, "008_classifier_examples.sql"],
		[9, "009_email_agent.sql"],
		[10, "010_classifier_provider_runs.sql"],
		[11, "011_agent_ui_messages.sql"],
		[12, "012_agent_model_catalog.sql"],
		[13, "013_agent_run_usage.sql"],

		[14, "014_tag_groups.sql"],
		[15, "015_jev_choice.sql"],
		[16, "016_jev_default_rubrics.sql"],
		[17, "017_agent_conversations.sql"],
		[18, "018_thread_status.sql"],
		[19, "019_retire_waiting_status.sql"],
		[20, "020_curated_examples.sql"],
		[21, "021_decision_rules.sql"],
		[22, "022_classification_attempts.sql"],
		[23, "023_ordered_scales.sql"],
		[24, "024_conversation_scores.sql"],
		[25, "025_mailbox_contacts.sql"],
		[27, "027_agent_classification_reviews.sql"],
		[28, "028_webhooks.sql"],
		[29, "029_historical_import.sql"],
		[30, "030_webhook_tag_filters.sql"],
		[31, "031_classifier_history.sql"],
		[32, "032_inbox_members.sql"],
		[33, "033_classifier_backfills.sql"],
		[34, "034_inbox_members_rollout.sql"],
		[35, "035_jev_credit_pause.sql"],
		[39, "039_api_keys.sql"],
		[40, "040_api_key_permissions.sql"],
		[41, "041_api_key_automation_permissions.sql"],
		[42, "042_sender_identities.sql"],
		[43, "043_sender_management.sql"],
		[44, "044_draft_intent.sql"],
		[45, "045_inbound_recovery.sql"],
		[46, "046_group_question_capacity.sql"],
		[47, "047_api_key_senders.sql"],
	] as const) {
		const ddl = await readFile(
			new URL(`../migrations/${filename}`, import.meta.url),
			"utf8",
		);
		await db.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(7342201)`;
			await tx`CREATE TABLE IF NOT EXISTS inbox_migrations (version integer PRIMARY KEY)`;
			const applied =
				await tx`SELECT version FROM inbox_migrations WHERE version = ${version}`;
			if (!applied.length) {
				await tx.unsafe(ddl);
				await tx`INSERT INTO inbox_migrations VALUES (${version})`;
			}
		});
	}
	// Concurrent index builds cannot run inside the migration transaction. A reserved
	// connection serializes index builds until they are valid and recorded.
	const sql = await db.reserve();
	const [memory] =
		await sql`SELECT current_setting('maintenance_work_mem') AS work_mem, current_setting('max_parallel_maintenance_workers') AS workers`;
	try {
		// Do not leave transactions waiting on a lock: concurrent index validation
		// must be able to wait for old snapshots without a circular dependency.
		while (
			!(await sql`SELECT pg_try_advisory_lock(7342236) AS acquired`)[0].acquired
		) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		for (const [version, filename, indexes] of [
			[
				36,
				"036_email_search.sql",
				["emails_substring_search", "emails_mailbox_date"],
			],
			[
				37,
				"037_runs_pagination.sql",
				[
					"classifier_provider_runs_mailbox_page",
					"classification_attempts_mailbox_page",
				],
			],
			[
				38,
				"038_list_filters.sql",
				[
					"emails_thread_list",
					"classifier_reviews_mailbox",
					"conversation_tags_manual",
				],
			],
		] as const) {
			if (
				(await sql`SELECT 1 FROM inbox_migrations WHERE version=${version}`)
					.length
			)
				continue;
			// Keep index construction within a small Neon compute's memory budget.
			// PostgreSQL 18 can parallelize GIN builds; use one worker for this migration.
			await sql`SELECT set_config('maintenance_work_mem','16MB',false), set_config('max_parallel_maintenance_workers','0',false)`;
			for (const name of indexes) {
				const [index] =
					await sql`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=${name}`;
				// An interrupted concurrent build leaves an invalid index. Retry it, but
				// retain completed indexes if a later statement failed.
				if (index && !index.indisvalid)
					await sql`DROP INDEX CONCURRENTLY ${sql(name)}`;
			}
			const ddl = await readFile(
				new URL(`../migrations/${filename}`, import.meta.url),
				"utf8",
			);
			for (const statement of ddl.split("-- statement-breakpoint"))
				await sql.unsafe(statement);
			await sql`INSERT INTO inbox_migrations VALUES(${version})`;
		}
	} finally {
		try {
			await sql`SELECT pg_advisory_unlock(7342236)`;
			await sql`SELECT set_config('maintenance_work_mem',${memory.work_mem},false), set_config('max_parallel_maintenance_workers',${memory.workers},false)`;
		} finally {
			sql.release();
		}
	}
}
