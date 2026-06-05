import type { Env } from "../types";
import { escapeHtml, stripHtmlToText } from "./email-helpers";

export interface AiDraftInput {
	email: {
		subject?: string | null;
		sender?: string | null;
		body?: string | null;
	};
	mailboxEmail: string;
	template?: {
		name: string;
		subject: string;
		bodyHtml: string;
	} | null;
	settings?: {
		model?: string | null;
		systemPrompt?: string | null;
	};
}

export interface AiDraftResult {
	model: string;
	bodyHtml: string;
	bodyText: string;
}

const DEFAULT_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function firstStringFromResponse(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return null;

	if (typeof value.response === "string") return value.response;
	if (typeof value.text === "string") return value.text;

	if (isRecord(value.result)) {
		const nested = firstStringFromResponse(value.result);
		if (nested) return nested;
	}

	if (Array.isArray(value.choices)) {
		for (const choice of value.choices) {
			const nested = firstStringFromResponse(choice);
			if (nested) return nested;
			if (isRecord(choice) && isRecord(choice.message)) {
				const message = firstStringFromResponse(choice.message);
				if (message) return message;
			}
		}
	}

	if (typeof value.content === "string") return value.content;
	return null;
}

function plainTextToHtml(text: string): string {
	const paragraphs = text
		.split(/\n{2,}/)
		.map((part) => part.trim())
		.filter(Boolean);
	if (paragraphs.length === 0) return "<p></p>";
	return paragraphs
		.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

function buildPrompt(input: AiDraftInput): string {
	const originalText = stripHtmlToText(input.email.body ?? "").slice(0, 6000);
	const templateText = input.template
		? stripHtmlToText(input.template.bodyHtml).slice(0, 2000)
		: "";
	const systemPrompt = input.settings?.systemPrompt?.trim()
		|| "Write a concise, professional email reply. Do not invent facts. Do not include a subject line.";

	return [
		systemPrompt,
		"",
		`Mailbox: ${input.mailboxEmail}`,
		`Original sender: ${input.email.sender ?? "unknown"}`,
		`Original subject: ${input.email.subject ?? "(no subject)"}`,
		templateText ? `Response template named "${input.template?.name}":\n${templateText}` : "",
		"Original email:",
		originalText || "(empty body)",
		"",
		"Draft only the reply body.",
	].filter(Boolean).join("\n");
}

export async function generateAiDraft(
	env: Env,
	input: AiDraftInput,
): Promise<AiDraftResult> {
	const model = input.settings?.model?.trim() || env.AI_DEFAULT_MODEL || DEFAULT_AI_MODEL;
	const prompt = buildPrompt(input);
	const answer: unknown = await env.AI.run(model as keyof AiModels, { prompt });
	const text = firstStringFromResponse(answer)?.trim();
	if (!text) throw new Error("AI model returned an empty draft");

	return {
		model,
		bodyHtml: plainTextToHtml(text),
		bodyText: text,
	};
}
