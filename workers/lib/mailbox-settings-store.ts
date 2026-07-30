import type { MailboxSignature } from "../../shared/mailbox-signature-settings.ts";
import type { Brand } from "../routes/brand.ts";
import { resolveAgentSystemPrompt } from "./prompts.ts";

const MAILBOX_SETTINGS_CAS_ATTEMPTS = 4;

export interface MailboxSettingsBucket {
	get(key: string): Promise<{
		etag: string;
		json(): Promise<unknown>;
	} | null>;
	put(
		key: string,
		value: string,
		options: { onlyIf: { etagMatches: string } },
	): Promise<{ etag: string } | null>;
}

export class MailboxSettingsNotFoundError extends Error {
	constructor() {
		super("Mailbox settings were not found");
		this.name = "MailboxSettingsNotFoundError";
	}
}

export class MailboxSettingsConflictError extends Error {
	constructor() {
		super("Mailbox settings changed concurrently. Please retry.");
		this.name = "MailboxSettingsConflictError";
	}
}

function settingsRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? { ...value }
		: {};
}

/**
 * The settings document as a client must see it: the stored `agentSystemPrompt`
 * resolved to the prompt actually in force, so the settings form can never show a
 * superseded default that the AI runtime has already stopped using. An absent or
 * empty prompt is left alone — it means "follow the brand default", which the form
 * renders as its placeholder.
 */
export function mailboxSettingsInForce(
	settings: Record<string, unknown>,
	brand: Brand,
): Record<string, unknown> {
	const stored = settings.agentSystemPrompt;
	if (typeof stored !== "string" || !stored.trim()) return settings;
	// Only a superseded default is rewritten. Everything else is served exactly as
	// stored, down to the byte, so a prompt the user wrote reaches the form as they
	// wrote it.
	const inForce = resolveAgentSystemPrompt(stored, brand);
	if (inForce === stored.trim()) return settings;
	return { ...settings, agentSystemPrompt: inForce };
}

export function mergeSignatureMailboxSettings(
	current: Record<string, unknown>,
	signature: MailboxSignature,
): Record<string, unknown> {
	return { ...current, signature: { ...signature } };
}

export function mergeGeneralMailboxSettings(
	current: Record<string, unknown>,
	requested: Record<string, unknown>,
): Record<string, unknown> {
	const { signature: _dedicatedSignature, ...generalUpdates } = requested;
	return { ...current, ...generalUpdates };
}

export async function updateMailboxSettings(
	bucket: MailboxSettingsBucket,
	mailboxAddress: string,
	merge: (current: Record<string, unknown>) => Record<string, unknown>,
	maxAttempts = MAILBOX_SETTINGS_CAS_ATTEMPTS,
): Promise<Record<string, unknown>> {
	const key = `mailboxes/${mailboxAddress.toLowerCase()}.json`;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const object = await bucket.get(key);
		if (!object) throw new MailboxSettingsNotFoundError();
		const next = merge(settingsRecord(await object.json()));
		const written = await bucket.put(key, JSON.stringify(next), {
			onlyIf: { etagMatches: object.etag },
		});
		if (written) return next;
	}
	throw new MailboxSettingsConflictError();
}
