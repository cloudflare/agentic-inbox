// Admin-facing quiz routes, mounted inside adminApp at /admin/quizzes (so they
// inherit adminApp's ADMIN-only guard). Hesham opens/closes quizzes, edits every
// question (paired EN/AR fields, so any string — incl. Arabic — is fixable without a
// code change), grades short answers, and reads the results table (design §5).

import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth";
import { escapeHtml } from "../lib/email-helpers";
import type { Env } from "../types";
import { isQuizEnabled } from "../lib/features";
import { resolveBrand } from "../routes/brand";
import { QUESTION_TYPES, QUIZ_STATUSES } from "../db/quiz-schema";
import type { QuizAnswerRow, QuizQuestionRow, QuizRow } from "../db/quiz-schema";
import type { SeedOption } from "./seed";
import { gradeMcqAnswer } from "./grading";
import { bi, biBlock, optionReadout, quizShell } from "./render";
import {
	attemptCounts,
	createQuestion,
	deleteQuestion,
	finalizeGrading,
	getAnswers,
	getAttemptById,
	getDisplayNames,
	getQuestion,
	getQuizById,
	gradeAnswer,
	listQuestions,
	listQuestionSubmissions,
	listQuizzes,
	listResults,
	moveQuestion,
	parseCorrect,
	parseOptions,
	parseSelected,
	seedQuizzes,
	setQuizStatus,
	updateQuestion,
	type QuestionInput,
	type QuestionSubmissionRow,
} from "./queries";

type AdminEnv = { Bindings: Env; Variables: { session?: SessionClaims } };

const OPTION_SLOTS = ["a", "b", "c", "d", "e", "f"] as const;

const adminQuizApp = new Hono<AdminEnv>();

// Match the rep-quiz gate: 404 the admin quiz console too where FEATURES omits
// the quiz, so no quiz surface exists in a Wiser environment (WISER-239).
adminQuizApp.use("*", async (c, next) => {
	if (!isQuizEnabled(c.env.FEATURES, resolveBrand(c.env.BRAND).id)) {
		return c.notFound();
	}
	return next();
});

function flash(c: { req: { query: (k: string) => string | undefined } }): string {
	const ok = c.req.query("ok");
	const err = c.req.query("err");
	if (ok) return `<div class="flash ok">${escapeHtml(ok)}</div>`;
	if (err) return `<div class="flash err">${escapeHtml(err)}</div>`;
	return "";
}

const STATUS_LABEL: Record<string, string> = { draft: "مسودة", open: "مفتوح", closed: "مقفول" };
function statusLabel(s: string): string {
	return bi(s, STATUS_LABEL[s] ?? s);
}

function statusBadge(status: string): string {
	const cls =
		status === "open" || status === "graded"
			? "ok"
			: status === "submitted"
				? "wait"
				: status === "closed"
					? "no"
					: "plain";
	return `<span class="tag ${cls}">${statusLabel(status)}</span>`;
}

/** Tidy award for display: the number as-is (0.5 → "0.5"), or "—" when ungraded. */
function fmtAward(n: number | null | undefined): string {
	return n === null || n === undefined ? "—" : String(n);
}

/** Clip a prompt for a compact list cell. */
function clip(s: string, n = 90): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The rep's shown identifier: their profile name (resolved into `display` by the
 * route), else the email's local part (strip everything from "@" on). */
function repName(s: QuestionSubmissionRow): string {
	return s.display?.trim() || s.email.split("@")[0];
}

/** Read-out of an MCQ's options for the admin: each option marked correct (✓) and/or
 * the rep's pick. Delegates to the shared optionReadout (also used on the rep review). */
function renderOptionReadout(q: QuizQuestionRow, selected: string[]): string {
	return optionReadout(parseOptions(q), parseCorrect(q), selected);
}

/** The award (0–points, any decimal) + note inputs for one answer. `idable` gives the
 * award input an id so the per-attempt "Accept" button can target it; the by-question
 * screen leaves it off and posts each row on its own. */
function awardFields(
	namePrefix: string,
	qid: string,
	points: number,
	awarded: number | null | undefined,
	note: string | null | undefined,
	opts: { idable?: boolean } = {},
): { award: string; note: string } {
	const id = opts.idable ? ` id="${namePrefix}_${qid}"` : "";
	return {
		award: `<label>${bi("Award", "الدرجة")} (0–${points})</label>
      <input${id} class="awardin" type="number" inputmode="decimal" name="${namePrefix}_${qid}" min="0" max="${points}" step="any" value="${awarded ?? ""}" placeholder="0–${points}">`,
		note: `<label>${bi("Note to rep", "ملاحظة للمندوب")}</label>
      <input name="note_${qid}" value="${escapeHtml(note ?? "")}" placeholder="${escapeHtml("…")}">`,
	};
}

// ── GET /admin/quizzes — overview + controls + seed ─────────────────
adminQuizApp.get("/", async (c) => {
	const quizzes = await listQuizzes(c.env);
	const rows = await Promise.all(
		quizzes.map(async (q) => {
			const counts = await attemptCounts(c.env, q.id);
			const segButtons = QUIZ_STATUSES.map(
				(s) =>
					`<button type="submit" name="status" value="${s}"${s === q.status ? ' class="is-current" disabled' : ""}>${statusLabel(s)}</button>`,
			).join("");
			return `<div class="qcard">
        <div class="qrow-split">
          <h2 style="margin:0">${bi(q.title_en, q.title_ar)} ${statusBadge(q.status)}</h2>
          <span class="muted">${counts.submitted} ${bi("submitted", "متسلّم")} · ${counts.graded} ${bi("graded", "متصحّح")}</span>
        </div>
        <div class="qrow-split" style="margin-top:14px;align-items:flex-end">
          <div>
            <div class="qtitle" style="margin-bottom:7px">${bi("Visibility to reps", "الظهور للمناديب")}</div>
            <form method="post" action="/admin/quizzes/${q.id}/status" class="seg" aria-label="${escapeHtml("Set status")}">${segButtons}</form>
          </div>
          <div class="editbtns">
            <a class="btn secondary sm" href="/admin/quizzes/${q.id}/questions">${bi("Edit questions", "تعديل الأسئلة")}</a>
            <a class="btn secondary sm" href="/admin/quizzes/${q.id}/grade">${bi("Grade", "تصحيح")}</a>
            <a class="btn secondary sm" href="/admin/quizzes/${q.id}/submissions">${bi("All submissions", "كل الإجابات")}</a>
            <a class="btn secondary sm" href="/admin/quizzes/${q.id}/results">${bi("Results", "النتائج")}</a>
          </div>
        </div>
      </div>`;
		}),
	);

	const body = `<h1 class="qhead">${bi("Quizzes", "الاختبارات")}</h1>
    <p class="qlede">${bi("Open or close each quiz, edit its questions, grade short answers, and read results. Only quizzes set to “open” are visible to reps.", "افتح أو اقفل كل اختبار، عدّل أسئلته، صحّح المقالي، واقرا النتائج. الاختبارات اللي حالتها «مفتوح» بس هي اللي بتظهر للمناديب.")}</p>
    ${flash(c)}
    ${
			rows.length
				? rows.join("")
				: `<div class="qcard qempty"><h2>${bi("No quizzes yet", "مفيش اختبارات")}</h2><p>${bi("Seed the two default quizzes below to get started.", "ازرع الاختبارين الافتراضيين تحت عشان تبدأ.")}</p></div>`
		}
    <div class="qcard">
      <h2 style="margin-top:0">${bi("Seed default quizzes", "زرع الاختبارات الافتراضية")}</h2>
      <p class="qlede">${bi("Inserts the two bundled quizzes if they're missing. Re-running is safe — existing quizzes are skipped.", "بيضيف الاختبارين المرفقين لو مش موجودين. إعادة التشغيل آمنة — الاختبارات الموجودة بتتخطّى.")}</p>
      <div class="editbtns" style="margin-top:6px">
        <form method="post" action="/admin/quizzes/seed" style="margin:0"><button type="submit">${bi("Seed default quizzes", "زرع الاختبارات")}</button></form>
        <form method="post" action="/admin/quizzes/seed?force=1" style="margin:0" onsubmit="return confirm('Force reseed DELETES existing questions for these quizzes and recreates them. Only safe before any attempts exist. Continue?')">
          <button type="submit" class="danger sm secondary">${bi("Force reseed", "إعادة زرع إجبارية")}</button>
        </form>
      </div>
    </div>`;
	return c.html(quizShell("Quizzes admin", body));
});

// ── POST /admin/quizzes/:quizId/status ──────────────────────────────
adminQuizApp.post("/:quizId/status", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const form = await c.req.parseBody();
	const status = String(form.status || "");
	if (!(QUIZ_STATUSES as readonly string[]).includes(status)) {
		return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Invalid status.")}`, 302);
	}
	await setQuizStatus(c.env, quiz.id, status as (typeof QUIZ_STATUSES)[number]);
	return c.redirect(`/admin/quizzes?ok=${encodeURIComponent(`${quiz.title_en} → ${status}.`)}`, 302);
});

// ── POST /admin/quizzes/seed ────────────────────────────────────────
adminQuizApp.post("/seed", async (c) => {
	const force = c.req.query("force") === "1";
	const report = await seedQuizzes(c.env, force);
	const msg =
		(report.created.length ? `Seeded: ${report.created.join(", ")}. ` : "") +
		(report.skipped.length ? `Skipped (already exist): ${report.skipped.join(", ")}.` : "");
	return c.redirect(`/admin/quizzes?ok=${encodeURIComponent(msg || "Nothing to seed.")}`, 302);
});

// ── GET /admin/quizzes/:quizId/questions — list + add/edit/reorder ───
adminQuizApp.get("/:quizId/questions", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const questions = await listQuestions(c.env, quiz.id);

	const list = questions.map((q, i) => renderAdminQuestion(quiz, q, i, questions.length)).join("");

	const body = `<h1 class="qhead">${bi(quiz.title_en, quiz.title_ar)}</h1>
    <p class="qlede">${questions.length} ${bi("questions", "سؤال")} · ${bi("edit any field in both languages; reorder or remove; add new ones below.", "عدّل أي خانة باللغتين؛ رتّب أو احذف؛ وضيف جداد تحت.")}</p>
    ${flash(c)}
    ${list || `<div class="qcard qempty"><h2>${bi("No questions yet", "مفيش أسئلة")}</h2><p>${bi("Add the first question below.", "ضيف أول سؤال تحت.")}</p></div>`}
    <div class="qcard">
      <h2 style="margin-top:0">${bi("Add a question", "إضافة سؤال")}</h2>
      ${questionForm(`/admin/quizzes/${quiz.id}/questions`, null)}
    </div>`;
	return c.html(quizShell("Edit questions", body, { backHref: "/admin/quizzes", backLabelEn: "All quizzes", backLabelAr: "كل الاختبارات" }));
});

/** One question in the admin list: read view + a collapsible (native <details>) edit
 * form + delete + reorder. */
function renderAdminQuestion(quiz: QuizRow, q: QuizQuestionRow, idx: number, total: number): string {
	const options = parseOptions(q);
	const correct = new Set(parseCorrect(q));
	const optsHtml =
		q.type === "short"
			? `<div class="ans-lbl">${bi("Rubric", "معايير التصحيح")}</div>${biBlock(q.rubric_en, q.rubric_ar, "qlede")}`
			: options
					.map(
						(o) =>
							`<div class="opt-read${correct.has(o.id) ? " correct" : ""}"><span class="slot">${escapeHtml(o.id)}</span><span class="otext">${bi(o.en, o.ar)}</span>${correct.has(o.id) ? `<span class="mark">✓</span>` : ""}</div>`,
					)
					.join("");

	const move = `<form method="post" action="/admin/quizzes/${quiz.id}/questions/${q.id}/move" class="inline editbtns">
    <button class="sm secondary" name="dir" value="up" type="submit"${idx === 0 ? " disabled" : ""} aria-label="Move up">↑</button>
    <button class="sm secondary" name="dir" value="down" type="submit"${idx === total - 1 ? " disabled" : ""} aria-label="Move down">↓</button></form>`;

	return `<div class="qcard">
    <div class="qrow-split">
      <div class="qindex">#${q.position} · ${escapeHtml(q.type)} · ${q.points} ${bi("pt", "نقطة")}</div>
      <div class="editbtns">${move}
        <a class="btn secondary sm" href="/admin/quizzes/${quiz.id}/questions/${q.id}/submissions">${bi("Submissions", "الإجابات")}</a>
        <form method="post" action="/admin/quizzes/${quiz.id}/questions/${q.id}/delete" class="inline" onsubmit="return confirm('Delete this question?')"><button class="sm danger secondary" type="submit">${bi("Delete", "حذف")}</button></form>
      </div>
    </div>
    ${q.title_en || q.title_ar ? `<div class="qtitle">${bi(q.title_en, q.title_ar)}</div>` : ""}
    <div class="qprompt" style="margin-bottom:10px">${bi(q.prompt_en, q.prompt_ar)}</div>
    ${optsHtml}
    ${q.type !== "short" && (q.explanation_en || q.explanation_ar) ? `<div class="why"><b>${bi("Why", "ليه")}:</b> ${bi(q.explanation_en, q.explanation_ar)}</div>` : ""}
    <details class="qedit"><summary>${bi("Edit this question", "تعديل السؤال")}</summary>
      ${questionForm(`/admin/quizzes/${quiz.id}/questions/${q.id}`, q)}
    </details>
  </div>`;
}

/** The add/edit form with paired EN/AR fields for every string + 6 option slots. */
function questionForm(action: string, q: QuizQuestionRow | null): string {
	const options = q ? parseOptions(q) : [];
	const correct = new Set(q ? parseCorrect(q) : []);
	const byId = new Map(options.map((o) => [o.id, o]));
	const val = (s: string | null | undefined) => escapeHtml(s ?? "");

	const typeOpts = QUESTION_TYPES.map(
		(t) => `<option value="${t}"${q?.type === t ? " selected" : ""}>${t}</option>`,
	).join("");

	const optionRows = OPTION_SLOTS.map((id) => {
		const o = byId.get(id) as SeedOption | undefined;
		return `<div class="opt-edit">
      <span class="slot">${id}</span>
      <input name="opt_${id}_en" placeholder="option ${id} (EN)" value="${val(o?.en)}">
      <input class="ar" name="opt_${id}_ar" dir="rtl" placeholder="الخيار ${id} (AR)" value="${val(o?.ar)}">
      <label class="ck"><input type="checkbox" name="correct_${id}" value="1"${correct.has(id) ? " checked" : ""}> ${bi("correct", "صح")}</label>
    </div>`;
	}).join("");

	return `<form method="post" action="${action}">
    <div class="pairgrid">
      <div><label>Title (EN)</label><input name="title_en" value="${val(q?.title_en)}"></div>
      <div><label>العنوان (AR)</label><input name="title_ar" dir="rtl" value="${val(q?.title_ar)}"></div>
    </div>
    <div class="pairgrid">
      <div><label>Prompt (EN)</label><textarea name="prompt_en" style="min-height:80px">${val(q?.prompt_en)}</textarea></div>
      <div><label>السؤال (AR)</label><textarea name="prompt_ar" dir="rtl" style="min-height:80px">${val(q?.prompt_ar)}</textarea></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 140px;gap:12px">
      <div><label>Type</label><select name="type">${typeOpts}</select></div>
      <div><label>Points</label><input name="points" type="number" min="1" value="${q?.points ?? 1}"></div>
    </div>
    <label style="margin-top:16px">${bi("Options — leave a slot blank to omit, tick the correct one(s). Ignored for short answers.", "الخيارات — سيب الخانة فاضية للتجاهل، علّم الصح. بتتجاهل في المقالي.")}</label>
    <div class="qcard" style="margin:6px 0;padding:6px 16px">${optionRows}</div>
    <div class="pairgrid">
      <div><label>Explanation / “Why” (EN)</label><textarea name="explanation_en" style="min-height:60px">${val(q?.explanation_en)}</textarea></div>
      <div><label>الشرح (AR)</label><textarea name="explanation_ar" dir="rtl" style="min-height:60px">${val(q?.explanation_ar)}</textarea></div>
    </div>
    <div class="pairgrid">
      <div><label>Rubric — short answers (EN)</label><textarea name="rubric_en" style="min-height:60px">${val(q?.rubric_en)}</textarea></div>
      <div><label>معايير التصحيح (AR)</label><textarea name="rubric_ar" dir="rtl" style="min-height:60px">${val(q?.rubric_ar)}</textarea></div>
    </div>
    <button type="submit" style="margin-top:16px">${q ? bi("Save changes", "حفظ التعديلات") : bi("Add question", "إضافة السؤال")}</button>
  </form>`;
}

/** Parse the question form into a QuestionInput. */
function parseQuestionForm(form: Record<string, string | File>): QuestionInput {
	const s = (k: string) => {
		const v = form[k];
		return typeof v === "string" ? v.trim() : "";
	};
	const typeRaw = s("type");
	const type = (QUESTION_TYPES as readonly string[]).includes(typeRaw)
		? (typeRaw as QuestionInput["type"])
		: "single";
	const points = Math.max(1, parseInt(s("points"), 10) || 1);

	const options: SeedOption[] = [];
	const correct: string[] = [];
	for (const id of OPTION_SLOTS) {
		const en = s(`opt_${id}_en`);
		const ar = s(`opt_${id}_ar`);
		if (!en && !ar) continue;
		options.push({ id, en, ar });
		if (form[`correct_${id}`]) correct.push(id);
	}

	return {
		type,
		points,
		title_en: s("title_en"),
		title_ar: s("title_ar"),
		prompt_en: s("prompt_en"),
		prompt_ar: s("prompt_ar"),
		options: type === "short" ? null : options,
		correct: type === "short" ? null : correct,
		explanation_en: s("explanation_en"),
		explanation_ar: s("explanation_ar"),
		rubric_en: s("rubric_en"),
		rubric_ar: s("rubric_ar"),
	};
}

// ── POST create / update / delete / move question ───────────────────
adminQuizApp.post("/:quizId/questions", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const input = parseQuestionForm(await c.req.parseBody());
	if (!input.prompt_en && !input.prompt_ar) {
		return c.redirect(`/admin/quizzes/${quiz.id}/questions?err=${encodeURIComponent("A prompt is required.")}`, 302);
	}
	await createQuestion(c.env, quiz.id, input);
	return c.redirect(`/admin/quizzes/${quiz.id}/questions?ok=${encodeURIComponent("Question added.")}`, 302);
});

adminQuizApp.post("/:quizId/questions/:questionId/delete", async (c) => {
	const quizId = c.req.param("quizId");
	await deleteQuestion(c.env, c.req.param("questionId"));
	return c.redirect(`/admin/quizzes/${quizId}/questions?ok=${encodeURIComponent("Question deleted.")}`, 302);
});

adminQuizApp.post("/:quizId/questions/:questionId/move", async (c) => {
	const quizId = c.req.param("quizId");
	const form = await c.req.parseBody();
	const dir = String(form.dir || "") === "up" ? "up" : "down";
	await moveQuestion(c.env, quizId, c.req.param("questionId"), dir);
	return c.redirect(`/admin/quizzes/${quizId}/questions?ok=${encodeURIComponent("Reordered.")}`, 302);
});

adminQuizApp.post("/:quizId/questions/:questionId", async (c) => {
	const quizId = c.req.param("quizId");
	const question = await getQuestion(c.env, c.req.param("questionId"));
	if (!question) return c.redirect(`/admin/quizzes/${quizId}/questions?err=${encodeURIComponent("Question not found.")}`, 302);
	const input = parseQuestionForm(await c.req.parseBody());
	if (!input.prompt_en && !input.prompt_ar) {
		return c.redirect(`/admin/quizzes/${quizId}/questions?err=${encodeURIComponent("A prompt is required.")}`, 302);
	}
	await updateQuestion(c.env, question.id, input);
	return c.redirect(`/admin/quizzes/${quizId}/questions?ok=${encodeURIComponent("Question saved.")}`, 302);
});

// ── GET /admin/quizzes/:quizId/grade — attempts awaiting grading ────
adminQuizApp.get("/:quizId/grade", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const results = await listResults(c.env, quiz.id);
	const questions = await listQuestions(c.env, quiz.id);

	const rowsFor = (status: string) =>
		results
			.filter((r) => r.status === status)
			.map(
				(r) =>
					`<tr><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.mailbox)}</td><td>${fmtAward(r.mcqScore)} / ${r.mcqMax ?? 0}</td>
            <td style="text-align:right"><a class="btn secondary sm" href="/admin/quizzes/${quiz.id}/grade/${r.attemptId}">${status === "graded" ? bi("Re-grade", "إعادة تصحيح") : bi("Grade", "صحّح")}</a></td></tr>`,
			)
			.join("");

	const submitted = rowsFor("submitted");
	const graded = rowsFor("graded");
	const tableHead = `<thead><tr><th>${bi("Email", "الإيميل")}</th><th>${bi("Mailbox", "الصندوق")}</th><th>MCQ</th><th></th></tr></thead>`;

	const byQuestion = questions
		.map(
			(q) =>
				`<tr><td><b>#${q.position}</b></td><td>${escapeHtml(q.type)} · ${q.points} ${bi("pt", "نقطة")}</td>
          <td style="white-space:normal;max-width:420px">${bi(clip(q.prompt_en), clip(q.prompt_ar))}</td>
          <td style="text-align:right"><a class="btn secondary sm" href="/admin/quizzes/${quiz.id}/questions/${q.id}/submissions">${bi("Submissions", "الإجابات")}</a></td></tr>`,
		)
		.join("");

	const body = `<h1 class="qhead">${bi(quiz.title_en, quiz.title_ar)}</h1>
    <p class="qlede">${bi("Grade each attempt — short answers, partial credit, or accepting a wrong multiple-choice answer — then finalize. Or grade one question across the whole team below.", "صحّح كل محاولة — المقالي، درجات جزئية، أو قبول إجابة اختيارات غلط — وبعدين أنهِ. أو صحّح سؤال واحد لكل الفريق تحت.")}</p>
    ${flash(c)}
    <div class="qcard"><h2 style="margin-top:0">${bi("Awaiting grading", "في انتظار التصحيح")} <span class="tag wait plain">${(submitted.match(/<tr>/g) || []).length}</span></h2>
      <div class="tablewrap"><table>${tableHead}
      <tbody>${submitted || `<tr><td colspan="4"><span class="muted">${bi("Nobody waiting.", "مفيش حد مستني.")}</span></td></tr>`}</tbody></table></div></div>
    <div class="qcard"><h2 style="margin-top:0">${bi("Already graded", "اتصحّح")}</h2>
      <div class="tablewrap"><table>${tableHead}
      <tbody>${graded || `<tr><td colspan="4"><span class="muted">${bi("None yet.", "لسه ولا واحد.")}</span></td></tr>`}</tbody></table></div></div>
    <div class="qcard"><div class="qrow-split"><h2 style="margin:0">${bi("Grade by question", "التصحيح بالسؤال")}</h2>
        <a class="btn secondary sm" href="/admin/quizzes/${quiz.id}/submissions">${bi("Open all on one page", "افتح الكل في صفحة")} →</a></div>
      <p class="qlede">${bi("Open one question to see and grade every rep's answer side-by-side — or open them all on one scrollable page.", "افتح سؤال واحد عشان تشوف وتصحّح إجابات كل المناديب جنب بعض — أو افتحهم كلهم في صفحة واحدة بسكرول.")}</p>
      <div class="tablewrap"><table>
      <tbody>${byQuestion || `<tr><td><span class="muted">${bi("No questions yet.", "مفيش أسئلة لسه.")}</span></td></tr>`}</tbody></table></div></div>`;
	return c.html(quizShell("Grade", body, { backHref: "/admin/quizzes", backLabelEn: "All quizzes", backLabelAr: "كل الاختبارات" }));
});

/** One question on the per-attempt grade page: the rep's answer in context (MCQ option
 * read-out or short text + rubric), the auto result, and an award + note input. Wrong
 * MCQs get a one-click "Accept · full marks" button. Lives inside the single grade form. */
function renderGradeQuestion(q: QuizQuestionRow, ans: QuizAnswerRow | undefined): string {
	const fields = awardFields("mark", q.id, q.points, ans?.awarded_points, ans?.grader_note, {
		idable: true,
	});

	let detail = "";
	let action = "";
	if (q.type === "short") {
		detail = `<div class="ans-lbl">${bi("Rubric", "معايير التصحيح")}</div>${biBlock(q.rubric_en, q.rubric_ar, "qlede")}
      <div class="ans-lbl">${bi("Rep's answer", "إجابة المندوب")}</div>
      <div class="preview" style="margin-top:6px">${escapeHtml(ans?.text_answer ?? "") || `<span class="muted">${bi("(blank)", "(فاضي)")}</span>`}</div>`;
	} else {
		const selected = ans ? parseSelected(ans) : [];
		const ok = ans?.is_correct === 1;
		// Recompute the auto award: awarded_points is the score of record (admin-
		// overridable), so it can't tell an auto partial from a manual override.
		const autoAwarded = ans
			? gradeMcqAnswer({ id: q.id, type: q.type, points: q.points, correct: parseCorrect(q) }, selected).awarded
			: 0;
		const partial = !ok && autoAwarded > 0 && autoAwarded < q.points;
		const autoChip = partial
			? `<span class="tag ok plain">${bi("Auto: partial", "تلقائي: جزئي")} · ${autoAwarded} / ${q.points}</span>`
			: ok
			? `<span class="tag ok plain">${bi("Auto: correct", "تلقائي: صح")}</span>`
			: `<span class="tag no plain">${bi("Auto: incorrect", "تلقائي: غلط")}</span>`;
		detail = `<div class="qrow-split"><span class="ans-lbl">${bi("✓ correct · ring = rep's pick", "✓ الصح · الإطار = اختيار المندوب")}</span> ${autoChip}</div>
      ${renderOptionReadout(q, selected)}
      ${q.explanation_en || q.explanation_ar ? `<div class="why"><b>${bi("Why", "ليه")}:</b> ${bi(q.explanation_en, q.explanation_ar)}</div>` : ""}`;
		if (!ok) {
			// type=button so it only fills the field; the single Finalize submit saves.
			action = `<button type="button" class="btn secondary sm" onclick="var e=document.getElementById('mark_${q.id}');e.value='${q.points}';e.focus();">${bi("Accept · full marks", "اقبلها · الدرجة كاملة")}</button>`;
		}
	}

	return `<div class="qcard" data-qgroup>
    <div class="qindex">#${q.position} · ${escapeHtml(q.type)} · ${q.points} ${bi("pt", "نقطة")}</div>
    ${q.title_en || q.title_ar ? `<div class="qtitle">${bi(q.title_en, q.title_ar)}</div>` : ""}
    <div class="qprompt">${bi(q.prompt_en, q.prompt_ar)}</div>
    ${detail}
    <div class="gradebar"><div>${fields.award}</div><div>${fields.note}</div><div>${action}</div></div>
  </div>`;
}

// ── GET /admin/quizzes/:quizId/grade/:attemptId — grade one attempt ─
adminQuizApp.get("/:quizId/grade/:attemptId", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const attempt = await getAttemptById(c.env, c.req.param("attemptId"));
	if (!attempt) return c.redirect(`/admin/quizzes/${quiz.id}/grade?err=${encodeURIComponent("Attempt not found.")}`, 302);

	const questions = await listQuestions(c.env, quiz.id);
	const answers = await getAnswers(c.env, attempt.id);
	const ansByQ = new Map(answers.map((a) => [a.question_id, a]));
	const who = (await listResults(c.env, quiz.id)).find((r) => r.attemptId === attempt.id);

	const cards = questions.map((q) => renderGradeQuestion(q, ansByQ.get(q.id))).join("");

	const body = `<h1 class="qhead">${bi("Grade attempt", "تصحيح المحاولة")}</h1>
    <p class="qlede">${who ? `${escapeHtml(who.email)} · ` : ""}${statusBadge(attempt.status)} · MCQ ${fmtAward(attempt.mcq_score)} / ${attempt.mcq_max ?? 0} · ${bi("Total", "الإجمالي")} ${fmtAward(attempt.total_score)} / ${attempt.total_max ?? 0}</p>
    ${flash(c)}
    <form id="quizform" method="post" action="/admin/quizzes/${quiz.id}/grade/${attempt.id}">
      ${cards || `<div class="qcard qempty"><p>${bi("This quiz has no questions.", "الاختبار ده مفيهوش أسئلة.")}</p></div>`}
      <div class="qcard qfooter">
        <span class="muted">${bi("Set an award for every question — partial credit and accepting a wrong answer are fine. Finalize recomputes the total and marks the attempt graded.", "حُط درجة لكل سؤال — تقدر تدي درجة جزئية أو تقبل إجابة غلط. الإنهاء بيعيد حساب الإجمالي ويعتبر المحاولة متصحّحة.")}</span>
        <button type="submit">${bi("Finalize grade", "إنهاء التصحيح")}</button>
      </div>
    </form>`;
	return c.html(quizShell("Grade attempt", body, { backHref: `/admin/quizzes/${quiz.id}/grade`, backLabelEn: "Back to grading", backLabelAr: "ارجع للتصحيح" }));
});

// ── POST /admin/quizzes/:quizId/grade/:attemptId — finalize ─────────
adminQuizApp.post("/:quizId/grade/:attemptId", async (c) => {
	const quizId = c.req.param("quizId");
	const attempt = await getAttemptById(c.env, c.req.param("attemptId"));
	if (!attempt) return c.redirect(`/admin/quizzes/${quizId}/grade?err=${encodeURIComponent("Attempt not found.")}`, 302);

	const questions = await listQuestions(c.env, attempt.quiz_id);
	const form = await c.req.parseBody();
	// Marks for EVERY question (MCQ + short); finalizeGrading clamps each to its max.
	// A blank field parses to NaN → clamped to 0. MCQ fields are pre-filled with the
	// current award, so leaving them untouched preserves the auto-grade.
	const marks: Record<string, { awarded: number; note: string }> = {};
	for (const q of questions) {
		marks[q.id] = {
			awarded: Number.parseFloat(String(form[`mark_${q.id}`] ?? "")),
			note: String(form[`note_${q.id}`] ?? ""),
		};
	}
	await finalizeGrading(c.env, attempt.id, marks);
	return c.redirect(`/admin/quizzes/${quizId}/results?ok=${encodeURIComponent("Attempt graded.")}`, 302);
});

/** Panel header above a question's submissions (anchor target for the jump nav):
 * index/title/prompt, plus the rubric for short answers. The MCQ answer key is shown by
 * the tally below (the correct option goes green), so it isn't repeated here. */
function renderQuestionPanel(q: QuizQuestionRow): string {
	return `<div class="qcard qpanel" id="q-${q.id}">
    <div class="qindex">#${q.position} · ${escapeHtml(q.type)} · ${q.points} ${bi("pt", "نقطة")}</div>
    ${q.title_en || q.title_ar ? `<div class="qtitle">${bi(q.title_en, q.title_ar)}</div>` : ""}
    <div class="qprompt">${bi(q.prompt_en, q.prompt_ar)}</div>
    ${q.type === "short" ? `<div class="ans-lbl">${bi("Rubric", "معايير التصحيح")}</div>${biBlock(q.rubric_en, q.rubric_ar, "qlede")}` : ""}
    ${q.type !== "short" && (q.explanation_en || q.explanation_ar) ? `<div class="why"><b>${bi("Why", "ليه")}:</b> ${bi(q.explanation_en, q.explanation_ar)}</div>` : ""}
  </div>`;
}

// ── GET /admin/quizzes/:quizId/questions/:questionId/submissions ─────
// One question, every rep's answer side-by-side, each gradable inline (design: the
// "view a question and see all its submissions at once" surface).
adminQuizApp.get("/:quizId/questions/:questionId/submissions", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const question = await getQuestion(c.env, c.req.param("questionId"));
	if (!question || question.quiz_id !== quiz.id) {
		return c.redirect(`/admin/quizzes/${quiz.id}/questions?err=${encodeURIComponent("Question not found.")}`, 302);
	}
	const subs = await listQuestionSubmissions(c.env, question.id);
	const names = await getDisplayNames(c.env, subs.map((s) => s.mailbox));
	for (const s of subs) s.display = names.get(s.mailbox.toLowerCase());

	const body = `<h1 class="qhead">${bi("Submissions", "الإجابات")}</h1>
    <p class="qlede">${subs.length} ${bi("reps answered this question.", "مندوب جاوبوا السؤال ده.")} · <a href="/admin/quizzes/${quiz.id}/submissions">${bi("View all questions on one page", "اعرض كل الأسئلة في صفحة واحدة")} →</a></p>
    ${flash(c)}
    ${renderQuestionBlock(quiz, question, subs)}`;
	return c.html(
		quizShell("Submissions", body, {
			backHref: `/admin/quizzes/${quiz.id}/questions`,
			backLabelEn: "Edit questions",
			backLabelAr: "تعديل الأسئلة",
		}),
	);
});

/** MCQ tally: the option list shown ONCE — correct option(s) green with a ✓ — and on
 * each option the name-chips of the reps who picked it (plus an "unanswered" row). The
 * compact alternative to repeating the whole option list per rep. */
function renderMcqTally(q: QuizQuestionRow, subs: QuestionSubmissionRow[]): string {
	const correct = new Set(parseCorrect(q));
	const byOption = new Map<string, QuestionSubmissionRow[]>();
	const unanswered: QuestionSubmissionRow[] = [];
	for (const s of subs) {
		if (s.selected.length === 0) unanswered.push(s);
		for (const id of s.selected) {
			const list = byOption.get(id) ?? [];
			list.push(s);
			byOption.set(id, list);
		}
	}
	const chip = (s: QuestionSubmissionRow) =>
		`<span class="namechip" title="${escapeHtml(s.email)}">${escapeHtml(repName(s))}</span>`;
	const optRows = parseOptions(q)
		.map((o) => {
			const pickers = byOption.get(o.id) ?? [];
			const isC = correct.has(o.id);
			return `<div class="opt-read opt-tally${isC ? " correct" : ""}">
        <div class="opt-read-head"><span class="slot">${escapeHtml(o.id)}</span><span class="otext">${bi(o.en, o.ar)}</span>${isC ? `<span class="mark">✓</span>` : ""}</div>
        <div class="pickers">${pickers.map(chip).join("") || `<span class="muted">—</span>`}</div>
      </div>`;
		})
		.join("");
	const blankRow = unanswered.length
		? `<div class="opt-read opt-tally"><div class="opt-read-head"><span class="otext muted">${bi("No answer", "مفيش إجابة")}</span></div><div class="pickers">${unanswered.map(chip).join("")}</div></div>`
		: "";
	return `<div class="qcard" style="margin-top:0">${optRows}${blankRow}</div>`;
}

/** Per-rep MCQ score adjustment for the tally view: name + what they chose + the auto
 * result + an award input (any decimal) + note, with a one-click "Full marks". Lets the
 * admin override one rep's MCQ score without leaving the submissions view. */
function renderMcqGradeRow(
	quiz: QuizRow,
	q: QuizQuestionRow,
	s: QuestionSubmissionRow,
	opts: { fromAll?: boolean } = {},
): string {
	const fromField = opts.fromAll ? `<input type="hidden" name="from" value="all">` : "";
	// Same recompute as renderGradeQuestion: the chip reports the auto result, not
	// the (possibly overridden) stored award shown in awardedChip next to it.
	const autoAwarded = gradeMcqAnswer(
		{ id: q.id, type: q.type, points: q.points, correct: parseCorrect(q) },
		s.selected,
	).awarded;
	const partial = s.isCorrect !== 1 && autoAwarded > 0 && autoAwarded < q.points;
	const auto =
		partial
			? `<span class="tag ok plain">${bi("Auto: partial", "تلقائي: جزئي")} · ${autoAwarded} / ${q.points}</span>`
			: s.isCorrect === 1
			? `<span class="tag ok plain">${bi("Auto: correct", "تلقائي: صح")}</span>`
			: `<span class="tag no plain">${bi("Auto: incorrect", "تلقائي: غلط")}</span>`;
	const awardedChip = `<span class="tag ${s.awarded == null ? "wait" : "ok"} plain awarded-chip">${fmtAward(s.awarded)} / ${q.points}</span>`;
	const chose = s.selected.length
		? escapeHtml(s.selected.join(", "))
		: `<span class="muted">${bi("blank", "فاضي")}</span>`;
	const inputId = `mk-${s.answerId}`;
	return `<div class="qcard" id="sub-${s.answerId}">
    <div class="qrow-split">
      <div class="qindex" style="margin:0" title="${escapeHtml(s.email)}">${escapeHtml(repName(s))} · <span class="muted">${bi("chose", "اختار")} ${chose}</span></div>
      <div class="editbtns">${auto} ${awardedChip} ${statusBadge(s.status)}</div>
    </div>
    <form method="post" action="/admin/quizzes/${quiz.id}/answers/${s.answerId}/award" class="gradebar">${fromField}
      <div><label>${bi("Award", "الدرجة")} (0–${q.points})</label>
        <input id="${inputId}" class="awardin" type="number" inputmode="decimal" name="points" min="0" max="${q.points}" step="any" value="${s.awarded ?? ""}" placeholder="0–${q.points}"></div>
      <div><label>${bi("Note to rep", "ملاحظة للمندوب")}</label><input name="note" value="${escapeHtml(s.note ?? "")}" placeholder="${escapeHtml("…")}"></div>
      <div class="editbtns">
        <button type="button" class="btn secondary sm" onclick="var e=document.getElementById('${inputId}');e.value='${q.points}';e.focus();">${bi("Full marks", "الدرجة كاملة")}</button>
        <button type="submit" class="sm">${bi("Save", "حفظ")}</button>
      </div>
    </form>
  </div>`;
}

/** One short answer with an inline award + note form that posts on its own (so the same
 * question can be graded across the whole team from one screen). `fromAll` tags the
 * form so its save returns to the all-questions scroll page (scrolled back to this
 * row). Short answers are per-rep; MCQ uses renderMcqTally instead. */
function renderShortSubmission(
	quiz: QuizRow,
	q: QuizQuestionRow,
	s: QuestionSubmissionRow,
	opts: { fromAll?: boolean } = {},
): string {
	const awardedChip = `<span class="tag ${s.awarded == null ? "wait" : "ok"} plain awarded-chip">${fmtAward(s.awarded)} / ${q.points}</span>`;
	const fromField = opts.fromAll ? `<input type="hidden" name="from" value="all">` : "";
	return `<div class="qcard" id="sub-${s.answerId}">
    <div class="qrow-split">
      <div class="qindex" style="margin:0" title="${escapeHtml(s.email)}">${escapeHtml(repName(s))}</div>
      <div class="editbtns">${awardedChip} ${statusBadge(s.status)}</div>
    </div>
    <div class="ans-lbl">${bi("Their answer", "إجابته")}</div>
    <div class="preview" style="margin-top:6px">${escapeHtml(s.textAnswer ?? "") || `<span class="muted">${bi("(blank)", "(فاضي)")}</span>`}</div>
    <form method="post" action="/admin/quizzes/${quiz.id}/answers/${s.answerId}/award" class="gradebar">${fromField}
      <div><label>${bi("Award", "الدرجة")} (0–${q.points})</label>
        <input class="awardin" type="number" inputmode="decimal" name="points" min="0" max="${q.points}" step="any" value="${s.awarded ?? ""}" placeholder="0–${q.points}"></div>
      <div><label>${bi("Note to rep", "ملاحظة للمندوب")}</label><input name="note" value="${escapeHtml(s.note ?? "")}" placeholder="${escapeHtml("…")}"></div>
      <div><button type="submit" class="sm">${bi("Save", "حفظ")}</button></div>
    </form>
  </div>`;
}

/** A question + its submissions, by type: MCQ → one option tally with name-chips on the
 * picked rows; short → per-rep cards with inline grading. Used by the single-question
 * page and the all-questions scroll page. */
function renderQuestionBlock(
	quiz: QuizRow,
	q: QuizQuestionRow,
	subs: QuestionSubmissionRow[],
	opts: { fromAll?: boolean } = {},
): string {
	const panel = renderQuestionPanel(q);
	if (q.type === "short") {
		const rows = subs.map((s) => renderShortSubmission(quiz, q, s, opts)).join("");
		return `${panel}${rows || `<div class="qcard qempty" style="margin-top:0"><p>${bi("No submissions for this question yet.", "مفيش إجابات للسؤال ده لسه.")}</p></div>`}`;
	}
	// MCQ: the tally (options once, who picked what) + a per-rep score adjuster.
	const adjust = subs.length
		? `<div class="ans-lbl" style="margin:18px 0 2px">${bi("Adjust scores", "ظبط الدرجات")}</div>${subs.map((s) => renderMcqGradeRow(quiz, q, s, opts)).join("")}`
		: "";
	return `${panel}${renderMcqTally(q, subs)}${adjust}`;
}

// ── GET /admin/quizzes/:quizId/submissions — ALL questions, each with its
// submissions stacked, gradable inline. The scroll-through alternative to clicking
// into one question at a time. ponytail: 1 query per question (parallel) and the whole
// quiz × all reps rendered at once — fine for the ~5-rep internal team; if the roster
// grows large, paginate by question or lazy-load each group.
adminQuizApp.get("/:quizId/submissions", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const questions = await listQuestions(c.env, quiz.id);
	const subsByQ = await Promise.all(questions.map((q) => listQuestionSubmissions(c.env, q.id)));
	const allSubs = subsByQ.flat();
	const names = await getDisplayNames(c.env, allSubs.map((s) => s.mailbox));
	for (const s of allSubs) s.display = names.get(s.mailbox.toLowerCase());

	const jump = questions.map((q) => `<a href="#q-${q.id}">${q.position}</a>`).join("");
	const sections = questions
		.map((q, i) => renderQuestionBlock(quiz, q, subsByQ[i], { fromAll: true }))
		.join("");

	const body = `<h1 class="qhead">${bi(quiz.title_en, quiz.title_ar)}</h1>
    <p class="qlede">${bi("Every question with all of its submissions, gradable inline. Scroll through, or jump to a question.", "كل سؤال وكل إجاباته، وتقدر تصحّح في مكانك. اعمل سكرول، أو اقفز لسؤال.")}</p>
    ${flash(c)}
    ${questions.length ? `<div class="qjump">${bi("Jump", "اقفز")}: ${jump}</div>` : ""}
    ${sections || `<div class="qcard qempty"><p>${bi("No questions yet.", "مفيش أسئلة لسه.")}</p></div>`}`;
	return c.html(
		quizShell("All submissions", body, {
			backHref: `/admin/quizzes/${quiz.id}/grade`,
			backLabelEn: "Back to grading",
			backLabelAr: "ارجع للتصحيح",
		}),
	);
});

// ── POST /admin/quizzes/:quizId/answers/:answerId/award — grade one ──
// Single-answer override (by-question + all-questions screens). gradeAnswer clamps +
// recomputes the owning attempt; redirect back to wherever the form was submitted
// from (all-questions scroll vs single question), scrolled to this row.
adminQuizApp.post("/:quizId/answers/:answerId/award", async (c) => {
	const quizId = c.req.param("quizId");
	const answerId = c.req.param("answerId");
	const form = await c.req.parseBody();
	const res = await gradeAnswer(
		c.env,
		answerId,
		Number.parseFloat(String(form.points ?? "")),
		String(form.note ?? ""),
	);
	if (!res.ok) {
		return c.redirect(`/admin/quizzes/${quizId}/results?err=${encodeURIComponent("Answer not found.")}`, 302);
	}
	const ok = encodeURIComponent("Saved.");
	const anchor = `#sub-${answerId}`;
	// `from` is a known discriminator, not a user-supplied URL — no open-redirect.
	const dest =
		String(form.from ?? "") === "all"
			? `/admin/quizzes/${quizId}/submissions?ok=${ok}${anchor}`
			: `/admin/quizzes/${quizId}/questions/${res.question.id}/submissions?ok=${ok}${anchor}`;
	return c.redirect(dest, 302);
});

// ── GET /admin/quizzes/:quizId/results — reps × scores ──────────────
adminQuizApp.get("/:quizId/results", async (c) => {
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return c.redirect(`/admin/quizzes?err=${encodeURIComponent("Quiz not found.")}`, 302);
	const results = await listResults(c.env, quiz.id);

	const rows = results
		.map(
			(r) =>
				`<tr>
          <td>${escapeHtml(r.email)}</td>
          <td>${escapeHtml(r.mailbox)}</td>
          <td>${fmtAward(r.mcqScore)} / ${r.mcqMax ?? 0}</td>
          <td>${fmtAward(r.shortScore)} / ${(r.totalMax ?? 0) - (r.mcqMax ?? 0)}</td>
          <td><b>${fmtAward(r.totalScore)} / ${r.totalMax ?? 0}</b></td>
          <td>${statusBadge(r.status)}</td>
          <td style="text-align:right"><a class="btn secondary sm" href="/admin/quizzes/${quiz.id}/grade/${r.attemptId}">${bi("View", "عرض")}</a></td>
        </tr>`,
		)
		.join("");

	const body = `<h1 class="qhead">${bi(quiz.title_en, quiz.title_ar)}</h1>
    <p class="qlede">${results.length} ${bi("reps have attempted this quiz. Open any row to see it question-by-question and adjust scores.", "مندوب جرّبوا الاختبار ده. افتح أي صف عشان تشوفه سؤال بسؤال وتظبط الدرجات.")}</p>
    ${flash(c)}
    <div class="qcard"><div class="tablewrap"><table>
      <thead><tr><th>${bi("Email", "الإيميل")}</th><th>${bi("Mailbox", "الصندوق")}</th><th>MCQ</th><th>${bi("Short", "مقالي")}</th><th>${bi("Total", "الإجمالي")}</th><th>${bi("Status", "الحالة")}</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7"><span class="muted">${bi("No attempts yet.", "مفيش محاولات لسه.")}</span></td></tr>`}</tbody>
    </table></div></div>`;
	return c.html(quizShell("Results", body, { backHref: "/admin/quizzes", backLabelEn: "All quizzes", backLabelAr: "كل الاختبارات" }));
});

export { adminQuizApp };
