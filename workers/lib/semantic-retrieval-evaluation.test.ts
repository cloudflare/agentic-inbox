import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mailboxMigrations } from "../durableObject/migrations.ts";
import { applySqliteMigrations } from "../testing/sqlite-migrations.test.ts";
import test from "node:test";
import { buildMailSearchPlan } from "./mail-search.ts";
import {
	evaluateFrozenRetrievalCorpus,
	evaluateSemanticRanking,
	frozenRetrievalGateDigest,
	meetsFrozenRetrievalThresholds,
	reciprocalRankFusion,
	semanticEvidenceIdentity,
	type FrozenSourceIdentity,
} from "./semantic-retrieval-evaluation.ts";
import {
	FROZEN_RETRIEVAL_THRESHOLDS_V1,
	FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1,
} from "./semantic-retrieval-evaluation-corpus.ts";

const messageA = {
	mailboxId: "legal@portal.test",
	source: "message",
	messageId: "a",
} satisfies FrozenSourceIdentity;
const attachmentB = {
	mailboxId: "legal@portal.test",
	source: "attachment",
	messageId: "b",
	attachmentId: "b-file",
} satisfies FrozenSourceIdentity;
const attachmentC = {
	mailboxId: "finance@portal.test",
	source: "attachment",
	messageId: "c",
	attachmentId: "c-file",
} satisfies FrozenSourceIdentity;
const distractor = {
	mailboxId: "ops@portal.test",
	source: "message",
	messageId: "x",
} satisfies FrozenSourceIdentity;

test("semantic evaluation uses the complete source identity and deterministic RRF", () => {
	assert.equal(
		semanticEvidenceIdentity(attachmentB),
		"legal@portal.test\u0000attachment\u0000b\u0000b-file",
	);
	const fused = reciprocalRankFusion(
		[
			[messageA, attachmentB],
			[attachmentB, attachmentC],
		],
		20,
	);
	assert.deepEqual(
		fused.map((candidate) => semanticEvidenceIdentity(candidate.source)),
		[
			semanticEvidenceIdentity(attachmentB),
			semanticEvidenceIdentity(messageA),
			semanticEvidenceIdentity(attachmentC),
		],
	);
	assert.ok(Math.abs(fused[0]!.score - 0.03252247488101534) < 1e-15);
	assert.ok(Math.abs(fused[1]!.score - 0.01639344262295082) < 1e-15);
	assert.ok(Math.abs(fused[2]!.score - 0.016129032258064516) < 1e-15);
	const originalLocaleCompare = String.prototype.localeCompare;
	String.prototype.localeCompare = () => -1;
	try {
		assert.deepEqual(
			reciprocalRankFusion([[attachmentC], [messageA]], 20).map((candidate) =>
				semanticEvidenceIdentity(candidate.source),
			),
			[
				semanticEvidenceIdentity(attachmentC),
				semanticEvidenceIdentity(messageA),
			],
		);
	} finally {
		String.prototype.localeCompare = originalLocaleCompare;
	}
});

function fts5Query(value: string): string {
	const tokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
	return tokens
		.map((token) => `"${token.replaceAll('"', '""')}"`)
		.join(" AND ");
}

function executeFrozenFts5Rankings(): Map<
	string,
	readonly FrozenSourceIdentity[]
> {
	const database = new DatabaseSync(":memory:");
	database.exec(
		"CREATE VIRTUAL TABLE evidence USING fts5(document_id UNINDEXED, searchable_text, tokenize='unicode61')",
	);
	const sourceByDocumentId = new Map(
		FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1.documents.map((document, index) => [
			`document-${index}`,
			document.source,
		]),
	);
	const insert = database.prepare(
		"INSERT INTO evidence (document_id, searchable_text) VALUES (?, ?)",
	);
	for (const [
		index,
		document,
	] of FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1.documents.entries()) {
		insert.run(`document-${index}`, document.searchableText);
	}
	const search = database.prepare(
		"SELECT document_id FROM evidence WHERE evidence MATCH ? ORDER BY bm25(evidence), document_id LIMIT ?",
	);
	const rankings = new Map<string, readonly FrozenSourceIdentity[]>();
	for (const testCase of FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1.cases) {
		const query = fts5Query(testCase.query);
		const ranking = query
			? search
					.all(query, 20)
					.map((row) => sourceByDocumentId.get(String(row.document_id))!)
			: [];
		rankings.set(testCase.id, ranking);
	}
	database.close();
	return rankings;
}

test("semantic evaluation computes worked recall, reciprocal rank, nDCG, and attachment recall", () => {
	const metrics = evaluateSemanticRanking({
		judgments: [
			{ source: messageA, relevance: 2 },
			{ source: attachmentB, relevance: 2 },
			{ source: attachmentC, relevance: 1 },
		],
		ranking: [messageA, distractor, attachmentC],
	});
	assert.equal(metrics.recallAt5, 2 / 3);
	assert.equal(metrics.recallAt10, 2 / 3);
	assert.equal(metrics.reciprocalRankAt10, 1);
	assert.ok(Math.abs(metrics.ndcgAt10 - 0.649014791936513) < 1e-15);
	assert.equal(metrics.attachmentRecallAt10, 1 / 2);
});

test("the frozen cross-Mailbox corpus satisfies locked system and fairness thresholds", async () => {
	const report = evaluateFrozenRetrievalCorpus(
		FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1,
		executeFrozenFts5Rankings(),
	);
	assert.equal(
		meetsFrozenRetrievalThresholds(report, FROZEN_RETRIEVAL_THRESHOLDS_V1),
		true,
		JSON.stringify(report),
	);
	assert.equal(report.searchV2.recallAt10, 0.25);
	assert.equal(report.fts5.recallAt10, 0.75);
	assert.equal(report.vector.recallAt10, 0.875);
	assert.equal(report.hybrid.recallAt10, 0.875);
	assert.equal(report.fts5.attachmentRecallAt10, 5 / 6);
	assert.equal(report.fts5.minimumMailboxRecallAt10, 2 / 3);
	assert.equal(report.vector.minimumMailboxRecallAt10, 2 / 3);
	assert.equal(report.hybrid.zeroResultPrecision, 1);
	assert.equal(
		FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1.policy.defaultEnablementEligible,
		false,
	);
	assert.equal(
		FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1.vectorObservation.controlledProviderRun,
		false,
	);
	const { gateSha256, ...digestInput } = FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1;
	assert.equal(
		await frozenRetrievalGateDigest({
			corpus: digestInput,
			thresholds: FROZEN_RETRIEVAL_THRESHOLDS_V1,
		}),
		gateSha256,
	);
});

test("the frozen Search v2 baseline executes through its production SQLite plan", () => {
	const database = new DatabaseSync(":memory:");
	// The real migrated mailbox schema: a hand-rolled copy drifts, and the plan
	// under test is the production one, columns and all.
	applySqliteMigrations(database, mailboxMigrations);
	database.exec(`
		INSERT OR REPLACE INTO folders (id, name) VALUES ('inbox', 'Inbox');
		INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, starred, body, thread_id)
		VALUES
			('message-renewal', 'inbox', 'Renewal documents', 'vendor@example.test', 'legal@portal.test',
			 '2026-07-01T10:00:00.000Z', 0, 0, 'Please review the attached agreement.', 't1'),
			('message-q3-forecast', 'inbox', 'Regional forecast', 'analyst@example.test', 'finance@portal.test',
			 '2026-07-02T10:00:00.000Z', 0, 0, 'The detailed figures are in the attached workbook.', 't2'),
			('message-loading-window', 'inbox', 'Dock schedule', 'warehouse@example.test', 'ops@portal.test',
			 '2026-07-03T10:00:00.000Z', 0, 0, 'The loading window closes at 14:30.', 't3'),
			('message-arabic-delivery', 'inbox', 'Delivery note', 'carrier@example.test', 'ops@portal.test',
			 '2026-07-04T10:00:00.000Z', 0, 0, 'The translated delivery detail is attached.', 't4');
		INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES
			('attachment-renewal-pdf', 'message-renewal', 'renewal.pdf', 'application/pdf', 1024),
			('attachment-q3-xlsx', 'message-q3-forecast', 'q3-cairo-east.xlsx', 'application/vnd.ms-excel', 2048),
			('attachment-q3-numbers', 'message-q3-forecast', 'q3-cairo-east.numbers', 'application/octet-stream', 512),
			('attachment-delivery-odt', 'message-arabic-delivery', 'delivery-ar.odt', 'application/vnd.oasis.opendocument.text', 256);
	`);
	const mailboxByMessage = new Map([
		["message-renewal", "legal@portal.test"],
		["message-q3-forecast", "finance@portal.test"],
		["message-loading-window", "ops@portal.test"],
		["message-arabic-delivery", "ops@portal.test"],
	]);
	for (const testCase of FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1.cases) {
		const plan = buildMailSearchPlan({
			query: testCase.query,
			limit: FROZEN_SEMANTIC_RETRIEVAL_CORPUS_V1.policy.resultLimit,
		});
		const actual = database
			.prepare(plan.dataSql)
			.all(...plan.dataParams)
			.map((row) => {
				const messageId = String(row.id);
				return semanticEvidenceIdentity({
					mailboxId: mailboxByMessage.get(messageId) ?? "unknown@portal.test",
					source: "message",
					messageId,
				});
			});
		assert.deepEqual(
			actual,
			testCase.observedRankings.searchV2.map(semanticEvidenceIdentity),
			testCase.id,
		);
	}
	database.close();
});
