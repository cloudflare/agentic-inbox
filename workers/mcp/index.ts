// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveBrand, type BrandConfig } from "../routes/brand";
import {
	hasExactLiveMailboxAccess,
	listExactLiveMailboxes,
} from "../lib/live-mailbox-authorization.ts";
import {
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
} from "../lib/tools";
import { Folders, FOLDER_TOOL_DESCRIPTION } from "../../shared/folders";
import {
	listQuizzes,
	getQuizById,
	getQuizByKey,
	attemptCounts,
	listResults,
	getAttemptById,
	getQuestion,
	listQuestions,
	listQuestionSubmissions,
	getAnswers,
	gradeAnswer,
	parseOptions,
	parseCorrect,
	parseSelected,
} from "../quiz/queries";
import type { UserRole } from "../db/users-schema";
import { getUserById } from "../lib/users";
import {
	LiveReadAuthorizationError,
	LiveReadAuthorizationUnavailableError,
	runLiveAuthorizedMutation,
	runLiveAuthorizedRead,
} from "../lib/live-authorized-read.ts";
import {
	mcpCredentialSessionVersion,
	mcpCredentialVersionMatches,
	quizAuthorizationFailure,
	type QuizAccessMode,
} from "../lib/mcp-authorization";
import type { Env } from "../types";

/** Per-connection identity, injected via ctx.props by the /mcp auth handler. */
interface McpProps {
	userId: string;
	role: UserRole;
	mailbox: string;
	scopes: string[];
	sessionVersion?: number;
	// McpAgent's props generic requires an index signature (Record<string, unknown>).
	[key: string]: unknown;
}

/** Wrap a plain result object into MCP content format. */
function mcpText(result: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(result, null, 2) },
		],
	};
}

/** Wrap an error string into MCP error format. */
function mcpError(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true as const,
	};
}

/**
 * Wrap a result that may contain an `error` field into MCP format,
 * automatically setting isError when appropriate.
 */
function mcpResult(result: Record<string, unknown>) {
	if ("error" in result) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			isError: true as const,
		};
	}
	return mcpText(result);
}

const MAILBOX_ARG_DESCRIPTION =
	"The mailbox email address. Omit to use your Personal Mailbox, or provide any mailbox you can access — call list_mailboxes to see them.";

/** MCP server identity for a brand — name, title, marketing URL, connector icons. */
function mcpServerInfo(b: BrandConfig) {
	return {
		name: `${b.id}-mail`,
		version: "1.0.0",
		title: b.appName,
		websiteUrl: b.websiteUrl,
		// MCP-native server icons (spec 2025-11-25). Best-effort connector branding:
		// clients that honor serverInfo.icons show the brand mark. Absolute https URLs
		// on the brand's prod host; PNG first (universally supported) then SVG fallback.
		icons: [
			{
				src: `${b.mailOrigin}${b.pwaIcon512}`,
				mimeType: "image/png",
				sizes: ["512x512"],
			},
			{
				src: `${b.mailOrigin}${b.mark}`,
				mimeType: "image/svg+xml",
				sizes: ["any"],
			},
		],
	};
}

/**
 * EmailMCP — exposes email tools over the Model Context Protocol, scoped per
 * authenticated user (locked-decisions D-64). Identity arrives as `this.props`,
 * set from the bearer token by the /mcp auth handler:
 * Every operation is authorized from live Personal ownership or Shared
 * membership before mailbox content or storage metadata is retrieved. Email
 * tools are intentionally limited to read, search, and reviewable Draft
 * creation. Sending and destructive actions stay in the human-operated portal.
 */
export class EmailMCP extends McpAgent<Env, unknown, McpProps> {
	// Brand-aware connector identity. `this.env` is set by the McpAgent base
	// constructor before this field initializes; resolveBrand fails safe to
	// whispyr if the BRAND var is ever absent.
	server = new McpServer(mcpServerInfo(resolveBrand(this.env.BRAND)));

	/**
	 * Resolve the requested mailbox identity. Live owner/membership authorization
	 * is enforced immediately afterward, before mailbox data is retrieved.
	 */
	#resolveMailbox(
		requested: string | undefined,
		_mode: "read" | "write",
	): { mailboxId: string } | { error: string } {
		const props = this.props;
		if (!props?.mailbox) return { error: "Unauthenticated MCP session." };
		const requiredScope = _mode === "read" ? "email.read" : "email.send";
		if (!props.scopes?.includes(requiredScope)) {
			return { error: `Forbidden: this connection lacks ${requiredScope}.` };
		}
		return { mailboxId: (requested || props.mailbox).toLowerCase() };
	}

	async init() {
		const env = this.env;

		const verifyLiveIdentity = async () => {
			const props = this.props;
			if (!props?.userId) return mcpError("Unauthenticated MCP session.");
			const user = await getUserById(env, props.userId);
			if (
				!user ||
				user.is_active !== 1 ||
				!mcpCredentialVersionMatches(props, user)
			) {
				return mcpError(
					"This MCP connection was revoked. Reconnect it before accessing mail.",
				);
			}
			return null;
		};

		const hasLiveMailboxAccess = async (mailboxId: string) => {
			const props = this.props;
			return Boolean(
				props?.userId &&
					(await hasExactLiveMailboxAccess(
						env,
						mailboxId,
						props.userId,
						mcpCredentialSessionVersion(props),
					)),
			);
		};

		const liveReadFailure = (error: unknown) => {
			if (error instanceof LiveReadAuthorizationError) {
				return mcpError(
					"This MCP connection or mailbox access changed during the read. Reconnect or choose an accessible mailbox.",
				);
			}
			if (error instanceof LiveReadAuthorizationUnavailableError) {
				return mcpError("Mail authorization is temporarily unavailable.");
			}
			return null;
		};

		const runMailboxRead = async <T>(mailboxId: string, read: () => Promise<T>) => {
			try {
				const result = await runLiveAuthorizedRead(
					() => hasLiveMailboxAccess(mailboxId),
					async () => {
						const object = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
						return object
							? { status: "found" as const, value: await read() }
							: { status: "missing" as const };
					},
				);
				return result.status === "found"
					? { status: "success" as const, value: result.value }
					: {
						status: "denied" as const,
						response: mcpError(`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`),
					};
			} catch (error) {
				const response = liveReadFailure(error);
				if (response) {
					return {
						status: "denied" as const,
						response,
					};
				}
				throw error;
			}
		};
		const runMailboxMutation = async <T>(
			mailboxId: string,
			mutate: () => Promise<T>,
		) => {
			try {
				const result = await runLiveAuthorizedMutation(
					() => hasLiveMailboxAccess(mailboxId),
					async () => {
						const object = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
						return object
							? { status: "found" as const, value: await mutate() }
							: { status: "missing" as const };
					},
				);
				return result.status === "found"
					? { status: "success" as const, value: result.value }
					: {
						status: "denied" as const,
						response: mcpError(`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`),
					};
			} catch (error) {
				const response = liveReadFailure(error);
				if (response) return { status: "denied" as const, response };
				throw error;
			}
		};

		// ── list_mailboxes ─────────────────────────────────────────
		this.server.tool(
			"list_mailboxes",
			"List the Personal and Shared Mailboxes you can access.",
			{},
			async () => {
				const userId = this.props?.userId;
				if (!userId) return mcpError("Unauthenticated MCP session.");
				if (!this.props?.scopes?.includes("email.read")) {
					return mcpError("Forbidden: this connection lacks email.read.");
				}
				let listedMailboxIds: string[] | undefined;
				let visible;
				try {
					visible = await runLiveAuthorizedRead(
						async () => {
							if (await verifyLiveIdentity()) return false;
							if (!listedMailboxIds) return true;
							const current = await listExactLiveMailboxes(
								env,
								userId,
								mcpCredentialSessionVersion(this.props ?? {}),
							);
							const currentIds = new Set(current.map((mailbox) => mailbox.id));
							return listedMailboxIds.every((mailboxId) => currentIds.has(mailboxId));
						},
						async () => {
							const rows = await listExactLiveMailboxes(
								env,
								userId,
								mcpCredentialSessionVersion(this.props ?? {}),
							);
							listedMailboxIds = rows.map((mailbox) => mailbox.id);
							return rows;
						},
					);
				} catch (error) {
					const response = liveReadFailure(error);
					if (response) return response;
					throw error;
				}
				return mcpText(
					visible.map((mailbox) => ({
						id: mailbox.address,
						email: mailbox.address,
						type: mailbox.type,
					})),
				);
			},
		);

		// ── list_emails ────────────────────────────────────────────
		this.server.tool(
			"list_emails",
			"List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				folder: z
					.string()
					.default(Folders.INBOX)
					.describe(FOLDER_TOOL_DESCRIPTION),
				limit: z
					.number()
					.default(20)
					.describe("Maximum number of emails to return"),
				page: z
					.number()
					.default(1)
					.describe("Page number for pagination"),
			},
			async ({ mailboxId, folder, limit, page }) => {
				const scoped = this.#resolveMailbox(mailboxId, "read");
				if ("error" in scoped) return mcpError(scoped.error);
				const result = await runMailboxRead(
					scoped.mailboxId,
					() => toolListEmails(env, scoped.mailboxId, { folder, limit, page }),
				);
				return result.status === "success"
					? mcpText(result.value)
					: result.response;
			},
		);

		// ── get_email ──────────────────────────────────────────────
		this.server.tool(
			"get_email",
			"Get a single email with its full body content. Use this to read the actual content of an email.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				emailId: z.string().describe("The email ID to retrieve"),
			},
			async ({ mailboxId, emailId }) => {
				const scoped = this.#resolveMailbox(mailboxId, "read");
				if ("error" in scoped) return mcpError(scoped.error);
				const read = await runMailboxRead(
					scoped.mailboxId,
					() => toolGetEmail(env, scoped.mailboxId, emailId),
				);
				if (read.status !== "success") return read.response;
				if ("error" in read.value) {
					return {
						content: [{ type: "text" as const, text: "Email not found" }],
						isError: true,
					};
				}
				return mcpText(read.value);
			},
		);

		// ── get_thread ─────────────────────────────────────────────
		this.server.tool(
			"get_thread",
			"Get all emails in a conversation thread. Returns all messages sorted chronologically.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				threadId: z
					.string()
					.describe("The thread_id to retrieve all messages for"),
			},
			async ({ mailboxId, threadId }) => {
				const scoped = this.#resolveMailbox(mailboxId, "read");
				if ("error" in scoped) return mcpError(scoped.error);
				const result = await runMailboxRead(
					scoped.mailboxId,
					() => toolGetThread(env, scoped.mailboxId, threadId),
				);
				return result.status === "success"
					? mcpText(result.value)
					: result.response;
			},
		);

		// ── search_emails ──────────────────────────────────────────
		this.server.tool(
			"search_emails",
			"Search for emails matching a query across subject and body fields.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				query: z.string().describe("Search query to match against subject and body"),
				folder: z
					.string()
					.optional()
					.describe("Optional folder to restrict search to"),
			},
			async ({ mailboxId, query, folder }) => {
				const scoped = this.#resolveMailbox(mailboxId, "read");
				if ("error" in scoped) return mcpError(scoped.error);
				const result = await runMailboxRead(
					scoped.mailboxId,
					() => toolSearchEmails(env, scoped.mailboxId, { query, folder }),
				);
				return result.status === "success"
					? mcpText(result.value)
					: result.response;
			},
		);

		// ── draft_reply ────────────────────────────────────────────
		this.server.tool(
			"draft_reply",
			"Draft a reply to an email and save it to the Drafts folder. Does NOT send — saves a draft for review.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line (usually 'Re: ...')"),
				bodyHtml: z
					.string()
					.describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }, extra) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const actor = { kind: "mcp" as const, id: this.props?.userId };
				const result = await runMailboxMutation(
					scoped.mailboxId,
					() => toolDraftReply(env, scoped.mailboxId, {
						originalEmailId,
						to,
						subject,
						body: bodyHtml,
						isPlainText: false,
						runVerifyDraft: true,
					}, actor, {
						surface: "mcp",
						toolName: "draft_reply",
						sessionId: extra.sessionId ?? this.getSessionId(),
						requestId: extra.requestId,
					}),
				);
				return result.status === "success"
					? mcpResult(result.value)
					: result.response;
			},
		);

		// ── create_draft ───────────────────────────────────────────
		this.server.tool(
			"create_draft",
			"Create a new draft email. Can be a new email or a reply draft.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				to: z
					.string()
					.optional()
					.describe("Recipient email address (optional for early drafts)"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the draft"),
				in_reply_to: z
					.string()
					.optional()
					.describe("The ID of the email this draft is replying to (optional)"),
				thread_id: z
					.string()
					.optional()
					.describe("Thread ID to attach this draft to (optional)"),
			},
			async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }, extra) => {
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const actor = { kind: "mcp" as const, id: this.props?.userId };
				const read = await runMailboxMutation(
					scoped.mailboxId,
					() => toolDraftEmail(env, scoped.mailboxId, {
						to: to || "",
						subject,
						body: bodyHtml,
						isPlainText: false,
						runVerifyDraft: true,
						in_reply_to,
						thread_id,
					}, actor, {
						surface: "mcp",
						toolName: "create_draft",
						sessionId: extra.sessionId ?? this.getSessionId(),
						requestId: extra.requestId,
					}),
				);
				if (read.status !== "success") return read.response;
				if ("error" in read.value) {
					return mcpResult(read.value);
				}
				return mcpText({
					status: "draft_created",
					draftId: read.value.draftId,
					threadId: read.value.threadId,
					replayed: read.value.replayed,
					message: read.value.message,
				});
			},
		);

		// ── update_draft ───────────────────────────────────────────
		this.server.tool(
			"update_draft",
			"Update an existing draft email's content.",
			{
				mailboxId: z.string().optional().describe(MAILBOX_ARG_DESCRIPTION),
				draftId: z.string().describe("The ID of the draft to update"),
				draftVersion: z
					.number()
					.int()
					.min(1)
					.describe("The exact draft_version returned when the draft was read"),
				to: z
					.string()
					.optional()
					.describe("Updated recipient email address"),
				subject: z.string().optional().describe("Updated subject line"),
				bodyHtml: z.string().optional().describe("Updated HTML body"),
			},
			async (input, extra) => {
				const { mailboxId } = input;
				const scoped = this.#resolveMailbox(mailboxId, "write");
				if ("error" in scoped) return mcpError(scoped.error);
				const actor = { kind: "mcp" as const, id: this.props?.userId };
				const read = await runMailboxMutation(
					scoped.mailboxId,
					() => toolUpdateDraft(env, scoped.mailboxId, input, actor, {
						surface: "mcp",
						toolName: "update_draft",
						sessionId: extra.sessionId ?? this.getSessionId(),
						requestId: extra.requestId,
					}),
				);
				if (read.status !== "success") return read.response;
				if ("error" in read.value) {
					if (read.value.error === "Draft not found") {
						return {
							content: [{ type: "text" as const, text: "Draft not found" }],
							isError: true,
						};
					}
					return mcpResult(read.value);
				}
				return mcpText(read.value);
			},
		);

		// ── Quiz tools (ADMIN only) ────────────────────────────────
		// Read all reps' quiz answers and grade them (partial credit, "accept anyway",
		// short-answer marks). Every tool requires an ADMIN token — quiz data spans the
		// whole team, so AGENT sessions get nothing here. Writes reuse the same clamp +
		// recompute path as the admin UI (workers/quiz/queries.ts).
		const requireQuizAdmin = async (mode: QuizAccessMode) => {
			const failure = await quizAuthorizationFailure(
				this.props,
				mode,
				(userId) => getUserById(env, userId),
			);
			return failure ? mcpError(failure) : null;
		};

		const runQuizRead = async <T>(read: () => Promise<T>) => {
			try {
				return {
					status: "success" as const,
					value: await runLiveAuthorizedRead(
						async () => !(await quizAuthorizationFailure(
							this.props,
							"read",
							(userId) => getUserById(env, userId),
						)),
						read,
					),
				};
			} catch (error) {
				if (error instanceof LiveReadAuthorizationError) {
					return {
						status: "denied" as const,
						response: mcpError(
							"Quiz access changed during the read. Reconnect before reading team results.",
						),
					};
				}
				if (error instanceof LiveReadAuthorizationUnavailableError) {
					return {
						status: "denied" as const,
						response: mcpError("Quiz authorization is temporarily unavailable."),
					};
				}
				throw error;
			}
		};

		/** Resolve a quiz by its id or its key ('real-estate-market' | 'whispyr-system'). */
		const resolveQuiz = async (ref: string) =>
			(await getQuizById(env, ref)) ?? (await getQuizByKey(env, ref));

		// ── quiz_overview ──────────────────────────────────────────
		this.server.tool(
			"quiz_overview",
			"ADMIN: list every quiz with its status and attempt counts (submitted / graded). Start here to find a quiz's id/key.",
			{},
			async () => {
				const read = await runQuizRead(async () => {
					const quizzes = await listQuizzes(env);
					return Promise.all(
						quizzes.map(async (q) => ({
							id: q.id,
							key: q.key,
							title_en: q.title_en,
							title_ar: q.title_ar,
							status: q.status,
							...(await attemptCounts(env, q.id)),
						})),
					);
				});
				return read.status === "success"
					? mcpText(read.value)
					: read.response;
			},
		);

		// ── quiz_results ───────────────────────────────────────────
		this.server.tool(
			"quiz_results",
			"ADMIN: the results table for one quiz — every rep with their MCQ / short / total scores, status, and attemptId (pass attemptId to quiz_attempt for the full breakdown).",
			{ quiz: z.string().describe("Quiz id or key (real-estate-market | whispyr-system)") },
			async ({ quiz }) => {
				const read = await runQuizRead(async () => {
					const q = await resolveQuiz(quiz);
					return q
						? { status: "found" as const, quiz: q, results: await listResults(env, q.id) }
						: { status: "missing" as const };
				});
				if (read.status !== "success") return read.response;
				if (read.value.status === "missing") {
					return mcpError(`Quiz "${quiz}" not found. Use quiz_overview to list quizzes.`);
				}
				return mcpText({
					quiz: {
						id: read.value.quiz.id,
						key: read.value.quiz.key,
						status: read.value.quiz.status,
					},
					results: read.value.results,
				});
			},
		);

		// ── quiz_attempt ───────────────────────────────────────────
		this.server.tool(
			"quiz_attempt",
			"ADMIN: one rep's full attempt — every question with its correct answer, the rep's selected/typed answer, the awarded points, auto-correctness, and any note. This is how you read the answers to grade them.",
			{ attemptId: z.string().describe("The attempt id (from quiz_results)") },
			async ({ attemptId }) => {
				const read = await runQuizRead(async () => {
					const attempt = await getAttemptById(env, attemptId);
					if (!attempt) return { status: "missing" as const };
					const [questions, answers, results] = await Promise.all([
						listQuestions(env, attempt.quiz_id),
						getAnswers(env, attempt.id),
						listResults(env, attempt.quiz_id),
					]);
					return { status: "found" as const, attempt, questions, answers, results };
				});
				if (read.status !== "success") return read.response;
				if (read.value.status === "missing") {
					return mcpError(`Attempt "${attemptId}" not found.`);
				}
				const { attempt, questions, answers, results } = read.value;
				const ansByQ = new Map(answers.map((a) => [a.question_id, a]));
				const rep = results.find((r) => r.attemptId === attempt.id);

				const detail = questions.map((q) => {
					const a = ansByQ.get(q.id);
					const base = {
						questionId: q.id,
						answerId: a?.id ?? null,
						position: q.position,
						type: q.type,
						points: q.points,
						prompt_en: q.prompt_en,
						prompt_ar: q.prompt_ar,
						awarded: a?.awarded_points ?? null,
						grader_note: a?.grader_note ?? null,
					};
					if (q.type === "short") {
						return { ...base, rubric_en: q.rubric_en, rubric_ar: q.rubric_ar, text_answer: a?.text_answer ?? null };
					}
					return {
						...base,
						options: parseOptions(q),
						correct: parseCorrect(q),
						selected: a ? parseSelected(a) : [],
						is_correct: a?.is_correct ?? null,
						explanation_en: q.explanation_en,
						explanation_ar: q.explanation_ar,
					};
				});

				return mcpText({
					attempt: {
						id: attempt.id,
						quiz_id: attempt.quiz_id,
						status: attempt.status,
						mcq_score: attempt.mcq_score,
						mcq_max: attempt.mcq_max,
						short_score: attempt.short_score,
						short_max: attempt.short_max,
						total_score: attempt.total_score,
						total_max: attempt.total_max,
					},
					rep: rep ? { userId: rep.userId, email: rep.email, mailbox: rep.mailbox } : null,
					questions: detail,
				});
			},
		);

		// ── quiz_question ──────────────────────────────────────────
		this.server.tool(
			"quiz_question",
			"ADMIN: one question with every rep's answer to it, for grading the same question across the whole team. Each submission includes its answerId (pass to quiz_grade_answer).",
			{ questionId: z.string().describe("The question id (from quiz_attempt)") },
			async ({ questionId }) => {
				const read = await runQuizRead(async () => {
					const question = await getQuestion(env, questionId);
					return question
						? {
							status: "found" as const,
							question,
							submissions: await listQuestionSubmissions(env, question.id),
						}
						: { status: "missing" as const };
				});
				if (read.status !== "success") return read.response;
				if (read.value.status === "missing") {
					return mcpError(`Question "${questionId}" not found.`);
				}
				const q = read.value.question;
				return mcpText({
					question: {
						id: q.id,
						quiz_id: q.quiz_id,
						position: q.position,
						type: q.type,
						points: q.points,
						prompt_en: q.prompt_en,
						prompt_ar: q.prompt_ar,
						options: parseOptions(q),
						correct: parseCorrect(q),
						rubric_en: q.rubric_en,
						rubric_ar: q.rubric_ar,
					},
					submissions: read.value.submissions,
				});
			},
		);

		// ── quiz_grade_answer ──────────────────────────────────────
		this.server.tool(
			"quiz_grade_answer",
			"ADMIN: set the awarded points (+ optional note) for ONE answer — partial credit or accepting a wrong answer. Points are clamped to [0, the question's max] in 0.5 steps; the owning attempt's totals are recomputed automatically.",
			{
				answerId: z.string().describe("The answer id (from quiz_attempt or quiz_question)"),
				points: z.number().describe("Points to award (0 to the question's max; 0.5 steps)"),
				note: z.string().optional().describe("Optional note shown to the rep after grading"),
			},
			async ({ answerId, points, note }) => {
				const denied = await requireQuizAdmin("write");
				if (denied) return denied;
				const res = await gradeAnswer(env, answerId, points, note ?? "");
				if (!res.ok) return mcpError(`Answer "${answerId}" not found.`);
				return mcpText({
					ok: true,
					questionId: res.question.id,
					attempt: {
						id: res.attempt.id,
						status: res.attempt.status,
						mcq_score: res.attempt.mcq_score,
						short_score: res.attempt.short_score,
						total_score: res.attempt.total_score,
						total_max: res.attempt.total_max,
					},
				});
			},
		);
	}
}
