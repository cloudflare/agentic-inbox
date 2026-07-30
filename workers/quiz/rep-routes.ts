// Rep-facing quiz routes, mounted at /quizzes in app.ts AFTER the auth gate (so a
// logged-out request is already bounced to /login) and BEFORE the React catch-all.
// Any logged-in role may take an open quiz. The take page never contains the answer
// key or explanations — grading happens server-side in POST /submit (design §5).

import { Hono, type Context } from "hono";
import type { SessionClaims } from "../lib/auth";
import { escapeHtml } from "../lib/email-helpers";
import type { Env } from "../types";
import { isQuizEnabled } from "../lib/features";
import { resolveBrand } from "../routes/brand";
import type { QuizAnswerRow, QuizQuestionRow, QuizRow } from "../db/quiz-schema";
import { bi, biBlock, optionReadout, quizShell, TIMER_SCRIPT, TAKE_SCRIPT } from "./render";
import {
	getAttempt,
	getAnswers,
	getQuizById,
	listOpenQuizzes,
	listQuestions,
	parseOptions,
	parseCorrect,
	parseSelected,
	submitAttempt,
} from "./queries";

type QuizEnv = { Bindings: Env; Variables: { session?: SessionClaims } };

const quizApp = new Hono<QuizEnv>();

// The rep-quiz is a Whispyr-only module. Where the env's FEATURES omits it, 404
// the whole surface so it is genuinely absent (not merely hidden) — e.g. Wiser
// (WISER-239). resolveBrand supplies the fail-safe default when FEATURES is unset.
quizApp.use("*", async (c, next) => {
	if (!isQuizEnabled(c.env.FEATURES, resolveBrand(c.env.BRAND).id)) {
		return c.notFound();
	}
	return next();
});

function notAvailable(c: Context<QuizEnv>, quiz?: QuizRow) {
	const t = quiz ? bi(quiz.title_en, quiz.title_ar) : bi("This quiz", "هذا الاختبار");
	return c.html(
		quizShell(
			"Not available",
			`<div class="qcard qempty">
        <h2>${bi("Not open right now", "مش مفتوح دلوقتي")}</h2>
        <p>${t} ${bi("isn't open at the moment. Check back once it's opened, or pick another from the list.", "مش مفتوح حاليًا. ارجع لما يتفتح، أو اختار واحد تاني من القايمة.")}</p>
        <div style="margin-top:16px"><a class="btn secondary" href="/quizzes">${bi("Back to quizzes", "ارجع للاختبارات")}</a></div>
      </div>`,
			{ backHref: "/quizzes", backLabelEn: "Quizzes", backLabelAr: "الاختبارات" },
		),
		200,
	);
}

// ── GET /quizzes — open quizzes + this rep's status ─────────────────
quizApp.get("/", async (c) => {
	const session = c.get("session")!;
	const quizzes = await listOpenQuizzes(c.env);

	const cards = await Promise.all(
		quizzes.map(async (q) => {
			const attempt = await getAttempt(c.env, q.id, session.sub);
			const status = attempt?.status; // undefined | submitted | graded
			const pill = !status
				? `<span class="tag">${bi("Not started", "لسه مبدأتش")}</span>`
				: status === "graded"
					? `<span class="tag ok">${bi("Graded", "اتصحّح")}</span>`
					: `<span class="tag wait">${bi("Submitted", "اتسلّم")}</span>`;
			const action = !status
				? `<a class="btn" href="/quizzes/${q.id}/take">${bi("Start quiz", "ابدأ الاختبار")} →</a>`
				: `<a class="btn secondary" href="/quizzes/${q.id}/result">${bi("Review results", "شوف النتيجة")}</a>`;
			return `<div class="qcard">
        <div class="qrow-split">${pill}</div>
        <h2>${bi(q.title_en, q.title_ar)}</h2>
        <div class="grow">${biBlock(q.description_en, q.description_ar, "qlede")}</div>
        <div class="acts">${action}</div>
      </div>`;
		}),
	);

	const body = `<h1 class="qhead">${bi("Quizzes", "الاختبارات")}</h1>
    <p class="qlede">${bi("Your assessments. Each one is a single attempt — take your time, your answers are saved as you go.", "اختباراتك. كل واحد محاولة واحدة بس — خد وقتك، إجاباتك بتتحفظ أول بأول.")}</p>
    ${
			cards.length
				? `<div class="qlist">${cards.join("")}</div>`
				: `<div class="qcard qempty"><h2>${bi("Nothing open yet", "مفيش حاجة مفتوحة")}</h2><p>${bi("There are no open quizzes right now. You'll see them here as soon as they're opened.", "مفيش اختبارات مفتوحة دلوقتي. هتلاقيهم هنا أول ما يتفتحوا.")}</p></div>`
		}`;
	return c.html(quizShell("Quizzes", body, { stagger: true }));
});

// ── GET /quizzes/:quizId/take — the quiz (NO answer key in payload) ──
quizApp.get("/:quizId/take", async (c) => {
	const session = c.get("session")!;
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return notAvailable(c);
	if (quiz.status !== "open") return notAvailable(c, quiz);

	const existing = await getAttempt(c.env, quiz.id, session.sub);
	if (existing) return c.redirect(`/quizzes/${quiz.id}/result`, 302);

	const questions = await listQuestions(c.env, quiz.id);
	const total = questions.length;
	const cards = questions.map((q, i) => renderTakeQuestion(q, i + 1, total)).join("");

	const progress = `<div class="qprog">
      <div class="qprog-top">
        <span class="qprog-label">${bi("Answered", "اتجاوب")} <span class="qprog-count" id="qprogcount">0 / ${total}</span></span>
        <span class="qprog-meta">
          <span class="savechip" id="qsave"
            data-saved-en="Saved" data-saved-ar="اتحفظ"
            data-restored-en="Draft restored" data-restored-ar="رجّعنا مسوّدتك"></span>
          <span>${bi("Time", "الوقت")} <span class="timer" id="elapsed" data-quiz="${quiz.id}">0:00</span></span>
        </span>
      </div>
      <div class="qprog-track"><span class="qprog-fill" id="qprogfill"></span></div>
    </div>`;

	const body = `<h1 class="qhead">${bi(quiz.title_en, quiz.title_ar)}</h1>
    ${biBlock(quiz.description_en, quiz.description_ar, "qlede")}
    <p class="qhint">${bi("One attempt. Multiple-choice is graded automatically; short answers are graded by the admin. Your progress is saved on this device as you go.", "محاولة واحدة. الاختيارات بتتصحّح تلقائيًا؛ والأسئلة المقالية بيصحّحها الأدمن. تقدّمك بيتحفظ على الجهاز ده أول بأول.")}</p>
    ${progress}
    <form id="quizform" method="post" action="/quizzes/${quiz.id}/submit" data-autosave="1" data-quiz="${quiz.id}" data-user="${escapeHtml(session.sub)}">
      ${cards}
      <div class="qcard qfooter">
        <span class="muted">${bi("Make sure you've answered everything before submitting — you only get one attempt.", "اتأكد إنك جاوبت على كل حاجة قبل ما تسلّم — عندك محاولة واحدة بس.")}</span>
        <button type="submit">${bi("Submit quiz", "سلّم الاختبار")}</button>
      </div>
    </form>`;

	return c.html(
		quizShell(quiz.title_en, body, {
			backHref: "/quizzes",
			backLabelEn: "Quizzes",
			backLabelAr: "الاختبارات",
			scripts: [TIMER_SCRIPT, TAKE_SCRIPT],
		}),
	);
});

/** A single question on the take page. Renders both languages; NEVER the answer key. */
function renderTakeQuestion(q: QuizQuestionRow, n: number, total: number): string {
	const head = `<div class="qindex">${bi("Question", "سؤال")} <b>${n}</b> ${bi(`of ${total}`, `من ${total}`)}</div>
    ${q.title_en || q.title_ar ? `<div class="qtitle">${bi(q.title_en, q.title_ar)}</div>` : ""}
    <div class="qprompt">${bi(q.prompt_en, q.prompt_ar)}</div>`;

	let inputs = "";
	if (q.type === "short") {
		inputs = `<textarea name="q_${q.id}" placeholder="${escapeHtml("…")}"></textarea>`;
	} else {
		const inputType = q.type === "multi" ? "checkbox" : "radio";
		const hint =
			q.type === "multi"
				? `<div class="qhint">${bi("Select all that apply.", "اختر كل ما ينطبق.")}</div>`
				: `<div class="qhint">${bi("Select one.", "اختر واحدة.")}</div>`;
		const opts = parseOptions(q)
			.map(
				(o) =>
					`<label class="opt"><input type="${inputType}" name="q_${q.id}" value="${escapeHtml(o.id)}">
            <span class="otext">${bi(o.en, o.ar)}</span></label>`,
			)
			.join("");
		inputs = `${hint}<div class="optset">${opts}</div>`;
	}

	return `<div class="qcard" data-qgroup>${head}${inputs}</div>`;
}

// ── POST /quizzes/:quizId/submit — single attempt, auto-grade MCQ ────
quizApp.post("/:quizId/submit", async (c) => {
	const session = c.get("session")!;
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return notAvailable(c);

	const existing = await getAttempt(c.env, quiz.id, session.sub);
	if (existing) return c.redirect(`/quizzes/${quiz.id}/result`, 302);
	if (quiz.status !== "open") return notAvailable(c, quiz);

	const questions = await listQuestions(c.env, quiz.id);
	const form = await c.req.parseBody({ all: true });

	const selectedByQuestion: Record<string, string[]> = {};
	const textByQuestion: Record<string, string> = {};
	for (const q of questions) {
		const raw = form[`q_${q.id}`];
		if (q.type === "short") {
			textByQuestion[q.id] = typeof raw === "string" ? raw : "";
		} else {
			const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
			selectedByQuestion[q.id] = values.filter((v): v is string => typeof v === "string");
		}
	}

	await submitAttempt(c.env, quiz, session.sub, selectedByQuestion, textByQuestion);
	return c.redirect(`/quizzes/${quiz.id}/result`, 302);
});

// ── GET /quizzes/:quizId/result — score + per-question review ────────
quizApp.get("/:quizId/result", async (c) => {
	const session = c.get("session")!;
	const quiz = await getQuizById(c.env, c.req.param("quizId"));
	if (!quiz) return notAvailable(c);

	const attempt = await getAttempt(c.env, quiz.id, session.sub);
	if (!attempt) return c.redirect(`/quizzes/${quiz.id}/take`, 302);

	const questions = await listQuestions(c.env, quiz.id);
	const answers = await getAnswers(c.env, attempt.id);
	const ansByQ = new Map(answers.map((a) => [a.question_id, a]));

	const graded = attempt.status === "graded";
	const rows = questions.map((q) => renderReviewRow(q, ansByQ.get(q.id))).join("");

	const mcqScore = attempt.mcq_score ?? 0;
	const mcqMax = attempt.mcq_max ?? 0;
	const totalScore = attempt.total_score ?? 0;
	const totalMax = attempt.total_max ?? 0;
	// The ring shows the final % once graded, otherwise the MCQ % so far.
	const pctScore = graded ? totalScore : mcqScore;
	const pctMax = graded ? totalMax : mcqMax;
	const pct = pctMax > 0 ? Math.round((pctScore / pctMax) * 100) : 0;

	const totalLine = graded
		? `<div class="scoreline"><span class="lbl">${bi("Final total", "الإجمالي النهائي")}</span><span class="scorebig">${totalScore} / ${totalMax}</span></div>`
		: `<div class="scoreline"><span class="lbl">${bi("Final total", "الإجمالي النهائي")}</span><span class="muted" style="text-align:right">${bi("Pending short-answer grading", "بانتظار تصحيح المقالي")}</span></div>`;

	const body = `<h1 class="qhead">${bi(quiz.title_en, quiz.title_ar)}</h1>
    <p class="qlede">${
			graded
				? bi("Graded — here's your full breakdown and what the right answers were.", "اتصحّح — دي تفاصيل درجاتك والإجابات الصح.")
				: bi("Submitted. Your multiple-choice score is below; short answers are with the admin.", "اتسلّم. درجة الاختيارات تحت؛ والمقالي مع الأدمن.")
		}</p>
    <div class="qcard qhero-card">
      <div class="qhero">
        <div class="ring" style="--p:${pct}"><div class="inner"><div class="pct">${pct}%</div><div class="of">${graded ? bi("final", "نهائي") : bi("so far", "للحين")}</div></div></div>
        <div class="breakdown">
          <div class="scoreline"><span class="lbl">${bi("Multiple-choice", "الاختيارات")}</span><span class="scorebig">${mcqScore} / ${mcqMax}</span></div>
          ${totalLine}
        </div>
      </div>
    </div>
    <h2 style="margin:calc(var(--q-gap) + 4px) 0 0">${bi("Review", "المراجعة")}</h2>
    ${rows}
    <div style="margin-top:18px"><a class="btn secondary" href="/quizzes">${bi("Back to quizzes", "ارجع للاختبارات")}</a></div>`;

	return c.html(
		quizShell(quiz.title_en, body, { backHref: "/quizzes", backLabelEn: "Quizzes", backLabelAr: "الاختبارات" }),
	);
});

/** A review row: the rep's answer + the correct answer + the "Why" (MCQ), or their
 * short text and (once graded) the awarded 0–3 + admin note. Correct answers ARE
 * shown here — that's the intended post-submission behaviour. */
function renderReviewRow(q: QuizQuestionRow, ans: QuizAnswerRow | undefined): string {
	const head = `${q.title_en || q.title_ar ? `<div class="qtitle">${bi(q.title_en, q.title_ar)}</div>` : ""}
    <div class="qprompt" style="margin-bottom:6px">${bi(q.prompt_en, q.prompt_ar)}</div>`;

	if (q.type === "short") {
		const text = ans?.text_answer ?? "";
		const awarded = ans?.awarded_points;
		const note = ans?.grader_note;
		const mark =
			awarded === null || awarded === undefined
				? `<span class="tag wait">${bi("Awaiting grading", "في انتظار التصحيح")}</span>`
				: `<span class="tag ok">${awarded} / ${q.points}</span>`;
		return `<div class="review-row">${head}
      <div class="qrow-split"><span class="ans-lbl">${bi("Your answer", "إجابتك")}</span> ${mark}</div>
      <div class="ans-line" style="white-space:pre-wrap">${escapeHtml(text) || `<span class="muted">${bi("(blank)", "(فاضي)")}</span>`}</div>
      ${note ? `<div class="why"><b>${bi("Note", "ملاحظة")}:</b> ${escapeHtml(note)}</div>` : ""}
    </div>`;
	}

	const options = parseOptions(q);
	const selected = ans ? parseSelected(ans) : [];
	const correct = parseCorrect(q);
	const isCorrect = ans?.is_correct === 1;
	const blank = selected.length === 0;

	// A non-exact MCQ can now earn automatic partial credit; manual full marks stays
	// "Accepted". `is_correct` remains the factual auto result in either case.
	const awarded = ans?.awarded_points;
	const auto = isCorrect ? q.points : 0;
	const partial = !isCorrect && awarded !== null && awarded !== undefined && awarded > 0 && awarded < q.points;
	const overridden = awarded !== null && awarded !== undefined && awarded !== auto;
	const overrideChip =
		partial
			? `<span class="tag ok">${bi("Partial", "جزئي")} · ${awarded} / ${q.points}</span>`
			: overridden && awarded! > 0
			? `<span class="tag ok">${!isCorrect ? `${bi("Accepted", "مقبولة")} · ` : ""}${awarded} / ${q.points}</span>`
			: overridden
				? `<span class="tag no">${awarded} / ${q.points}</span>`
				: "";
	const note = ans?.grader_note;

	// Each option on its own row with the rep's pick + the correct answer marked —
	// readable even when options are full sentences (unlike a comma-joined line).
	return `<div class="review-row ${isCorrect ? "correct" : "wrong"}">${head}
	    <div class="qrow-split"><span class="ans-lbl">${bi("✓ correct · your pick highlighted", "✓ الصح · اختيارك مظلّل")}</span> <span class="editbtns">${isCorrect ? `<span class="tag ok">${bi("Correct", "صح")}</span>` : partial ? "" : `<span class="tag no">${bi("Incorrect", "غلط")}</span>`}${overrideChip}</span></div>
    ${optionReadout(options, correct, selected, { en: "your pick", ar: "اختيارك" })}
    ${blank ? `<div class="ans-line"><span class="muted">${bi("You left this blank.", "سِبتها فاضية.")}</span></div>` : ""}
    ${q.explanation_en || q.explanation_ar ? `<div class="why"><b>${bi("Why", "ليه")}:</b> ${bi(q.explanation_en, q.explanation_ar)}</div>` : ""}
    ${note ? `<div class="why"><b>${bi("Note", "ملاحظة")}:</b> ${escapeHtml(note)}</div>` : ""}
  </div>`;
}

export { quizApp };
