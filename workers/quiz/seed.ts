// Bundled seed content for the two default quizzes. The JSON files are the
// reviewed source (copied from the vault); after `POST /admin/quizzes/seed`
// upserts them, D1 is the source of truth and questions are edited in-panel.
// See design.md §8.

import realEstateMarket from "./seed/real-estate-market-quiz-2026-08.json";
import whispyrSystem from "./seed/whispyr-system-quiz-2026-08.json";

export type Lang = "en" | "ar";
export interface Bilingual {
	en: string;
	ar: string;
}
export type QuestionType = "single" | "multi" | "short";

export interface SeedOption {
	id: string;
	en: string;
	ar: string;
}

export interface SeedQuestion {
	position: number;
	type: QuestionType;
	points: number;
	title: Bilingual;
	prompt: Bilingual;
	options?: SeedOption[]; // MCQ only
	correct?: string[]; // MCQ only — option ids
	explanation?: Bilingual; // MCQ only
	rubric?: Bilingual; // short only
}

export interface SeedQuiz {
	key: string;
	title: Bilingual;
	description: Bilingual;
	scoring: { total: number; mcq: number; short: number };
	questions: SeedQuestion[];
}

// The JSON loader infers `type` as `string`; cast through unknown to the strict shape.
export const SEED_QUIZZES: SeedQuiz[] = [
	realEstateMarket as unknown as SeedQuiz,
	whispyrSystem as unknown as SeedQuiz,
];
