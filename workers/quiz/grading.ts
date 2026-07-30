// Pure, server-side grading for quiz attempts (design.md section 6). Kept
// dependency-free and side-effect-free so it is trivially testable (see
// grading.test.ts) -- this is the money/correctness path, so it never touches the
// DB or the request.

export type QuestionType = "single" | "multi" | "short";

export interface GradableQuestion {
	id: string;
	type: QuestionType;
	points: number;
	correct: string[] | null; // option ids for MCQ; null for short
}

/** Canonical key for an option-id set: de-duplicated + sorted, so order and
 * accidental duplicates never affect equality. */
function setKey(ids: string[]): string {
	return [...new Set(ids)].sort().join(" ");
}

/**
 * Grade one MCQ answer. Each distinct correct selection earns one equal unit and
 * each distinct wrong selection loses one; the result is rounded to two decimals
 * then clamped to the question's range. `isCorrect` still means an exact set match.
 * Short answers never reach here.
 */
export function gradeMcqAnswer(
	q: GradableQuestion,
	selected: string[],
): { awarded: number; isCorrect: boolean } {
	const selectedSet = new Set(selected);
	const correct = new Set(q.correct ?? []);
	if (correct.size === 0) return { awarded: 0, isCorrect: false };

	const unit = q.points / correct.size;
	const raw =
		unit * [...selectedSet].filter((id) => correct.has(id)).length -
		unit * [...selectedSet].filter((id) => !correct.has(id)).length;
	const awarded = Math.min(q.points, Math.max(0, Math.round(raw * 100) / 100));
	return { awarded, isCorrect: setKey(selected) === setKey([...correct]) };
}

/**
 * Clamp a (possibly garbage) admin-entered award to a valid value for a question
 * worth `max` points: a number in [0, max], snapped to the nearest 0.5 step (so the
 * UI's partial-credit affordance can't smuggle in float noise). NaN → 0. This is the
 * single gate every manual override passes through, MCQ or short alike.
 */
export function clampAward(raw: number, max: number): number {
	if (!Number.isFinite(raw)) return 0;
	const rounded = Math.round(raw * 100) / 100; // 2 decimals — allows 0.25, 0.1, …
	return Math.min(max, Math.max(0, rounded));
}

export interface GradedAnswer {
	questionId: string;
	awarded: number | null; // null for short (admin-graded later)
	isCorrect: number | null; // 1/0 for MCQ, null for short
}

export interface SubmissionGrade {
	answers: GradedAnswer[];
	mcqScore: number; // auto, sum of MCQ awarded
	mcqMax: number; // sum of MCQ points
	shortMax: number; // sum of short points
	totalMax: number; // mcqMax + shortMax
}

/**
 * Grade a whole submission. `selectedByQuestion` maps a question id to the chosen
 * option ids (missing/empty means unanswered means 0). The `*_max` totals are
 * computed from the quiz's current questions, never hardcoded, so editing questions
 * keeps the math correct. Short questions contribute to `shortMax` only; their
 * awarded stays null.
 */
export function gradeSubmission(
	questions: GradableQuestion[],
	selectedByQuestion: Record<string, string[]>,
): SubmissionGrade {
	const answers: GradedAnswer[] = [];
	let mcqScore = 0;
	let mcqMax = 0;
	let shortMax = 0;

	for (const q of questions) {
		if (q.type === "short") {
			shortMax += q.points;
			answers.push({ questionId: q.id, awarded: null, isCorrect: null });
			continue;
		}
		mcqMax += q.points;
		const { awarded, isCorrect } = gradeMcqAnswer(q, selectedByQuestion[q.id] ?? []);
		mcqScore += awarded;
		answers.push({ questionId: q.id, awarded, isCorrect: isCorrect ? 1 : 0 });
	}

	return { answers, mcqScore, mcqMax, shortMax, totalMax: mcqMax + shortMax };
}

export interface ScoreQuestion {
	id: string;
	type: QuestionType;
	points: number;
}

export interface AttemptScore {
	mcqScore: number;
	mcqMax: number;
	shortScore: number;
	shortMax: number;
	totalScore: number;
	totalMax: number;
	allShortGraded: boolean; // true ⇒ attempt is fully graded
}

/**
 * Recompute an attempt's totals from the *current* per-answer awards — the single
 * source of truth once an admin can override any question (MCQ partial credit,
 * "accept anyway", short-answer marks). `awardsByQuestion` maps a question id to its
 * stored `awarded_points` (null = not yet graded, treated as 0 but flips
 * `allShortGraded` false). Maxes are summed from the questions, never hardcoded, so
 * the math survives question edits. Sums are rounded to 0.5 to kill float drift.
 */
export function scoreFromAwards(
	questions: ScoreQuestion[],
	awardsByQuestion: Record<string, number | null | undefined>,
): AttemptScore {
	let mcqScore = 0;
	let mcqMax = 0;
	let shortScore = 0;
	let shortMax = 0;
	let allShortGraded = true;

	for (const q of questions) {
		const awarded = awardsByQuestion[q.id];
		if (q.type === "short") {
			shortMax += q.points;
			if (awarded === null || awarded === undefined) allShortGraded = false;
			else shortScore += awarded;
		} else {
			mcqMax += q.points;
			mcqScore += awarded ?? 0;
		}
	}

	const round = (n: number) => Math.round(n * 100) / 100; // 2 dp, kills float drift
	mcqScore = round(mcqScore);
	shortScore = round(shortScore);
	return {
		mcqScore,
		mcqMax,
		shortScore,
		shortMax,
		totalScore: round(mcqScore + shortScore),
		totalMax: mcqMax + shortMax,
		allShortGraded,
	};
}
