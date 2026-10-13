// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Password credentials in R2 under platform/identity/passwords/.
 * Principal keys: `user:<uuid>` plus optional contact `email:` and IdP `sub:`.
 *
 * Layout (current):
 * - platform/identity/passwords/{userId}.json
 * - platform/identity/logins/by-email/{email}.json → { userId }
 * - platform/identity/logins/by-mailbox/{canonical}.json → { userId }
 *
 * Legacy (dual-read / dual-write during migration):
 * - platform/users/{userId}.json
 * - platform/users-by-email/{email}.json
 * - platform/users-by-login/{canonical}.json
 */

import { normalizeEmailAddress } from "./mail-automations.ts";
import { canonicalMailboxId } from "./mailbox-routing.ts";
import type { RequestPrincipal } from "./mailbox-acl.ts";

export const PLATFORM_USERS_PREFIX = "platform/identity/passwords/";
export const PLATFORM_USERS_BY_EMAIL_PREFIX =
	"platform/identity/logins/by-email/";
export const PLATFORM_USERS_BY_LOGIN_PREFIX =
	"platform/identity/logins/by-mailbox/";

export const LEGACY_PLATFORM_USERS_PREFIX = "platform/users/";
export const LEGACY_PLATFORM_USERS_BY_EMAIL_PREFIX = "platform/users-by-email/";
export const LEGACY_PLATFORM_USERS_BY_LOGIN_PREFIX = "platform/users-by-login/";

export type PlatformUser = {
	id: string;
	/** Contact / notification email (invite destination). */
	contactEmail: string;
	/** Primary mailbox address this user owns (login email for password). */
	mailboxEmail?: string;
	passwordHash: string;
	/** Linked IdP subs (Apple/Google), stored without prefix. */
	linkedSubs: string[];
	createdAt: string;
	updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function userR2Key(userId: string): string {
	return `${PLATFORM_USERS_PREFIX}${userId}.json`;
}

export function legacyUserR2Key(userId: string): string {
	return `${LEGACY_PLATFORM_USERS_PREFIX}${userId}.json`;
}

export function userByEmailKey(email: string): string {
	const normalized = normalizeEmailAddress(email) ?? email.toLowerCase();
	return `${PLATFORM_USERS_BY_EMAIL_PREFIX}${normalized}.json`;
}

export function legacyUserByEmailKey(email: string): string {
	const normalized = normalizeEmailAddress(email) ?? email.toLowerCase();
	return `${LEGACY_PLATFORM_USERS_BY_EMAIL_PREFIX}${normalized}.json`;
}

export function userByLoginKey(loginEmail: string): string {
	const canonical = canonicalMailboxId(loginEmail) ?? loginEmail.toLowerCase();
	return `${PLATFORM_USERS_BY_LOGIN_PREFIX}${canonical}.json`;
}

export function legacyUserByLoginKey(loginEmail: string): string {
	const canonical = canonicalMailboxId(loginEmail) ?? loginEmail.toLowerCase();
	return `${LEGACY_PLATFORM_USERS_BY_LOGIN_PREFIX}${canonical}.json`;
}

export function parsePlatformUser(raw: unknown): PlatformUser | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.id !== "string" || !raw.id) return null;
	if (typeof raw.contactEmail !== "string") return null;
	if (typeof raw.passwordHash !== "string") return null;
	const linkedSubs = Array.isArray(raw.linkedSubs)
		? raw.linkedSubs.filter((s): s is string => typeof s === "string")
		: [];
	return {
		id: raw.id,
		contactEmail: raw.contactEmail,
		mailboxEmail:
			typeof raw.mailboxEmail === "string" ? raw.mailboxEmail : undefined,
		passwordHash: raw.passwordHash,
		linkedSubs,
		createdAt:
			typeof raw.createdAt === "string"
				? raw.createdAt
				: new Date().toISOString(),
		updatedAt:
			typeof raw.updatedAt === "string"
				? raw.updatedAt
				: new Date().toISOString(),
	};
}

async function readUserJson(
	bucket: R2Bucket,
	key: string,
): Promise<PlatformUser | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;
	try {
		return parsePlatformUser(await obj.json());
	} catch {
		return null;
	}
}

export async function loadPlatformUser(
	bucket: R2Bucket,
	userId: string,
): Promise<PlatformUser | null> {
	const current = await readUserJson(bucket, userR2Key(userId));
	if (current) return current;

	const legacy = await readUserJson(bucket, legacyUserR2Key(userId));
	if (!legacy) return null;

	// Migrate on read: rewrite under the new layout (keeps legacy keys too).
	await savePlatformUser(bucket, legacy);
	return legacy;
}

async function readUserIdPointer(
	bucket: R2Bucket,
	key: string,
): Promise<string | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;
	try {
		const parsed = await obj.json();
		if (isRecord(parsed) && typeof parsed.userId === "string") {
			return parsed.userId;
		}
	} catch {
		/* ignore */
	}
	return null;
}

export async function findUserIdByLoginEmail(
	bucket: R2Bucket,
	loginEmail: string,
): Promise<string | null> {
	const byLogin =
		(await readUserIdPointer(bucket, userByLoginKey(loginEmail))) ??
		(await readUserIdPointer(bucket, legacyUserByLoginKey(loginEmail)));
	if (byLogin) return byLogin;

	// Members (no mailbox login claim) authenticate with invite contact email.
	return (
		(await readUserIdPointer(bucket, userByEmailKey(loginEmail))) ??
		(await readUserIdPointer(bucket, legacyUserByEmailKey(loginEmail)))
	);
}

export async function savePlatformUser(
	bucket: R2Bucket,
	user: PlatformUser,
): Promise<void> {
	const body = JSON.stringify(user);
	await bucket.put(userR2Key(user.id), body);
	// Dual-write legacy during migration window.
	await bucket.put(legacyUserR2Key(user.id), body);

	const contact = normalizeEmailAddress(user.contactEmail);
	if (contact) {
		const ptr = JSON.stringify({ userId: user.id });
		await bucket.put(userByEmailKey(contact), ptr);
		await bucket.put(legacyUserByEmailKey(contact), ptr);
	}
	if (user.mailboxEmail) {
		const ptr = JSON.stringify({ userId: user.id });
		await bucket.put(userByLoginKey(user.mailboxEmail), ptr);
		await bucket.put(legacyUserByLoginKey(user.mailboxEmail), ptr);
	}
}

/**
 * Only the mailbox login is an identity. `contactEmail` was never verified
 * (invite and signup forms accept any address), so it stays contact info.
 */
export function principalFromPlatformUser(
	user: PlatformUser,
): RequestPrincipal {
	return {
		email: user.mailboxEmail
			? (canonicalMailboxId(user.mailboxEmail) ?? user.mailboxEmail)
			: undefined,
		sub: `user:${user.id}`,
	};
}

/**
 * Legacy ACL keys for a password user (method-scoped). Prefer writing
 * `account:{identityAccountId}` via ensurePrincipalAccount for new ACL rows.
 */
export function aclKeysForPlatformUser(user: PlatformUser): string[] {
	const keys = new Set<string>();
	keys.add(`user:${user.id}`);
	if (user.mailboxEmail) {
		const mailbox = canonicalMailboxId(user.mailboxEmail) ?? user.mailboxEmail;
		keys.add(`email:${mailbox}`);
	}
	for (const sub of user.linkedSubs) {
		if (sub.trim()) keys.add(`sub:${sub.trim()}`);
	}
	return [...keys];
}

/** Account-scoped ACL key for mailbox ownership / membership. */
export function accountAclKey(accountId: string): string {
	const id = accountId.trim();
	return id.startsWith("account:") ? id : `account:${id}`;
}
