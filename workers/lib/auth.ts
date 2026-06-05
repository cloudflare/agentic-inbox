import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import {
	ensureAppSchemaOnce,
	getMailboxRecord,
	getMailboxRole,
	resolveCurrentUser,
	type MailboxWithAccess,
} from "./app-db";
import {
	getCapabilitiesForRole,
	type AccessIdentity,
	type AppUserRecord,
	type MailboxCapabilities,
} from "./permissions";

export interface AuthVariables {
	accessIdentity: AccessIdentity;
	currentUser: AppUserRecord;
	mailboxStub: DurableObjectStub<MailboxDO>;
	mailboxAccess: MailboxWithAccess;
}

export type AppContext = {
	Bindings: Env;
	Variables: AuthVariables;
};

type CapabilityName = keyof MailboxCapabilities;

export function getRequiredUser(c: { var: Partial<AuthVariables> }): AppUserRecord {
	const user = c.var.currentUser;
	if (!user) throw new Error("currentUser missing; requireActiveUser middleware must run first");
	return user;
}

export const requireActiveUser = createMiddleware<AppContext>(async (c, next) => {
	await ensureAppSchemaOnce(c.env.APP_DB);
	const identity = c.var.accessIdentity;
	if (!identity) return c.json({ error: "Missing Access identity" }, 403);

	const user = await resolveCurrentUser(c.env.APP_DB, identity, new Date().toISOString());
	if (!user) {
		return c.json({
			error: "Registration required",
			registrationStatus: "unregistered",
			email: identity.email,
		}, 403);
	}
	if (user.status !== "active") {
		return c.json({
			error: user.status === "pending" ? "Registration pending approval" : "User disabled",
			registrationStatus: user.status,
			user,
		}, 403);
	}

	c.set("currentUser", user);
	await next();
});

export const requireGlobalAdmin = createMiddleware<AppContext>(async (c, next) => {
	const user = getRequiredUser(c);
	if (user.globalRole !== "admin") {
		return c.json({ error: "Global admin required" }, 403);
	}
	await next();
});

export function requireMailboxPermission(capability: CapabilityName) {
	return createMiddleware<AppContext>(async (c, next) => {
		const user = getRequiredUser(c);
		const rawId = c.req.param("mailboxId");
		if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
		const mailboxId = decodeURIComponent(rawId).toLowerCase();

		const mailbox = await getMailboxRecord(c.env.APP_DB, mailboxId);
		if (!mailbox) return c.json({ error: "Not found" }, 404);

		const role = await getMailboxRole(c.env.APP_DB, user, mailbox.id);
		const capabilities = getCapabilitiesForRole(role);
		if (role === "none" || !capabilities[capability]) {
			return c.json({ error: "Insufficient mailbox permission" }, 403);
		}

		const key = `mailboxes/${mailbox.id}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) return c.json({ error: "Mailbox storage not found" }, 404);

		const ns = c.env.MAILBOX;
		const stub = ns.get(ns.idFromName(mailbox.id));
		c.set("mailboxStub", stub);
		c.set("mailboxAccess", {
			...mailbox,
			role,
			capabilities,
		});
		await next();
	});
}
