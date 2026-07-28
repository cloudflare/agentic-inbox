import type { MailboxRow } from "../db/users-schema.ts";
import type { Env } from "../types.ts";
import {
	runLiveAuthorizedRead,
	runLiveAuthorizedSnapshotRead,
} from "./live-authorized-read.ts";

export type LiveMailboxAuthorizationIdentity = {
	mailboxId: string;
	userId: string;
	sessionVersion: number | undefined;
};

export type LiveMailboxAccessAuthorizer = (
	env: Env,
	mailboxId: string,
	userId: string,
	sessionVersion: number | undefined,
) => Promise<boolean>;

export type ExactLiveMailboxRoster = {
	mailboxIds: readonly string[];
};

export type ExactLiveMailboxRosterLoader = (
	env: Env,
	userId: string,
	sessionVersion: number | undefined,
) => Promise<ExactLiveMailboxRoster | null>;

export async function hasExactLiveMailboxAccess(
	env: Env,
	mailboxId: string,
	userId: string,
	sessionVersion: number | undefined,
): Promise<boolean> {
	if (sessionVersion === undefined) return false;
	return Boolean(
		await env.DB.prepare(
			`SELECT 1 AS authorized
			 FROM users u
			 JOIN mailboxes m ON m.id = ?
			 WHERE u.id = ?
			   AND u.is_active = 1
			   AND u.session_version = ?
			   AND m.is_active = 1
			   AND (
			     u.role = 'ADMIN'
			     OR (m.type = 'PERSONAL' AND m.owner_user_id = u.id)
			     OR (m.type = 'SHARED' AND EXISTS (
			       SELECT 1 FROM mailbox_memberships mm
			       WHERE mm.mailbox_id = m.id AND mm.user_id = u.id
			     ))
			   )
			 LIMIT 1`,
		)
			.bind(mailboxId.toLowerCase(), userId, sessionVersion)
			.first(),
	);
}

export async function runLiveMailboxAuthorizedRead<T>(
	env: Env,
	identity: LiveMailboxAuthorizationIdentity,
	read: () => Promise<T>,
	authorize: LiveMailboxAccessAuthorizer = hasExactLiveMailboxAccess,
): Promise<T> {
	return runLiveAuthorizedRead(
		() => authorize(
			env,
			identity.mailboxId,
			identity.userId,
			identity.sessionVersion,
		),
		read,
	);
}

/**
 * Capture the exact active credential generation and its complete canonical
 * Mailbox roster in one query. LEFT JOIN preserves an active zero-Mailbox user
 * while an inactive or stale credential returns no row at all.
 */
export async function loadExactLiveMailboxRoster(
	env: Env,
	userId: string,
	sessionVersion: number | undefined,
): Promise<ExactLiveMailboxRoster | null> {
	if (sessionVersion === undefined) return null;
	// Per Cloudflare D1 read-replication docs, direct binding queries continue to
	// execute on the primary unless Sessions API is used. Authorization stays on
	// the direct binding so both snapshots require the latest committed grants.
	const result = await env.DB.prepare(
		`SELECT u.id AS user_id, m.id AS mailbox_id
		 FROM users u
		 LEFT JOIN mailboxes m
		   ON m.is_active = 1
		  AND (
		    u.role = 'ADMIN'
		    OR (m.type = 'PERSONAL' AND m.owner_user_id = u.id)
		    OR (m.type = 'SHARED' AND EXISTS (
		      SELECT 1 FROM mailbox_memberships mm
		      WHERE mm.mailbox_id = m.id AND mm.user_id = u.id
		    ))
		  )
		 WHERE u.id = ?
		   AND u.is_active = 1
		   AND u.session_version = ?
		 ORDER BY m.id ASC`,
	)
		.bind(userId, sessionVersion)
		.all<{ user_id: string; mailbox_id: string | null }>();
	if (result.results.length === 0) return null;
	return {
		mailboxIds: [...new Set(
			result.results.flatMap((row) =>
				row.mailbox_id === null ? [] : [row.mailbox_id],
			),
		)].sort(),
	};
}

function sameExactRoster(
	before: ExactLiveMailboxRoster,
	after: ExactLiveMailboxRoster,
): boolean {
	return before.mailboxIds.length === after.mailboxIds.length &&
		before.mailboxIds.every((mailboxId, index) =>
			mailboxId === after.mailboxIds[index]
		);
}

export async function runExactLiveMailboxRosterRead<T>(
	env: Env,
	identity: Pick<LiveMailboxAuthorizationIdentity, "userId" | "sessionVersion">,
	read: () => Promise<T>,
	load: ExactLiveMailboxRosterLoader = loadExactLiveMailboxRoster,
): Promise<T> {
	return runLiveAuthorizedSnapshotRead(
		() => load(env, identity.userId, identity.sessionVersion),
		sameExactRoster,
		read,
	);
}

export async function listExactLiveMailboxes(
	env: Env,
	userId: string,
	sessionVersion: number | undefined,
): Promise<MailboxRow[]> {
	if (sessionVersion === undefined) return [];
	const result = await env.DB.prepare(
		`SELECT m.id, m.address, m.type, m.owner_user_id, m.is_active,
		        m.created_at, m.updated_at
		 FROM users u
		 JOIN mailboxes m ON m.is_active = 1
		 WHERE u.id = ?
		   AND u.is_active = 1
		   AND u.session_version = ?
		   AND (
		     u.role = 'ADMIN'
		     OR (m.type = 'PERSONAL' AND m.owner_user_id = u.id)
		     OR (m.type = 'SHARED' AND EXISTS (
		       SELECT 1 FROM mailbox_memberships mm
		       WHERE mm.mailbox_id = m.id AND mm.user_id = u.id
		     ))
		   )
		 ORDER BY m.address ASC`,
	)
		.bind(userId, sessionVersion)
		.all<MailboxRow>();
	return result.results;
}

export async function listStableLiveMailboxes(
	env: Env,
	userId: string,
	sessionVersion: number | undefined,
	load: typeof listExactLiveMailboxes = listExactLiveMailboxes,
): Promise<MailboxRow[]> {
	const listed = await load(env, userId, sessionVersion);
	const currentIds = new Set(
		(await load(env, userId, sessionVersion)).map((mailbox) => mailbox.id),
	);
	return listed.filter((mailbox) => currentIds.has(mailbox.id));
}

export async function currentAgentActorSessionVersion(
	env: Env,
	mailboxId: string,
	userId: string,
): Promise<number | null> {
	const current = await env.DB.prepare(
		`SELECT u.is_active AS user_active, u.session_version,
		        m.is_active AS mailbox_active,
		        CASE
		          WHEN u.role = 'ADMIN' THEN 1
		          WHEN m.type = 'PERSONAL' AND m.owner_user_id = u.id THEN 1
		          WHEN m.type = 'SHARED' AND EXISTS (
		            SELECT 1 FROM mailbox_memberships mm
		            WHERE mm.mailbox_id = m.id AND mm.user_id = u.id
		          ) THEN 1
		          ELSE 0
		        END AS authorized
		 FROM users u
		 LEFT JOIN mailboxes m ON m.id = ?
		 WHERE u.id = ?`,
	)
		.bind(mailboxId.toLowerCase(), userId)
		.first<{
			user_active: number;
			session_version: number;
			mailbox_active: number | null;
			authorized: number;
		}>();
	return current?.user_active === 1 &&
		current.mailbox_active === 1 &&
		current.authorized === 1
		? current.session_version
		: null;
}

export async function isAgentMailboxActive(
	env: Env,
	mailboxId: string,
): Promise<boolean> {
	const mailbox = await env.DB.prepare(
		"SELECT is_active FROM mailboxes WHERE id = ?",
	)
		.bind(mailboxId.toLowerCase())
		.first<{ is_active: number }>();
	return mailbox?.is_active === 1;
}
