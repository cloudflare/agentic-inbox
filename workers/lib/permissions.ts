export type UserStatus = "pending" | "active" | "disabled";
export type GlobalRole = "admin" | "none";
export type MailboxRole = "manager" | "responder" | "viewer";
export type EffectiveRole = "admin" | MailboxRole | "none";

export interface AccessIdentity {
	sub: string;
	email: string;
}

export interface AppUserRecord {
	id: string;
	email: string;
	accessSub: string | null;
	status: UserStatus;
	globalRole: GlobalRole;
	displayName: string | null;
	createdAt: string;
	updatedAt: string;
	lastLoginAt: string | null;
}

export interface MailboxCapabilities {
	readMail: boolean;
	mutateMail: boolean;
	sendMail: boolean;
	manageMailbox: boolean;
	manageMembers: boolean;
	manageTemplates: boolean;
	useTemplates: boolean;
	manageAi: boolean;
	useAi: boolean;
}

export interface AiDraftGateSettings {
	enabled: boolean;
}

export interface ResolvedAccessUser {
	action: "matched-sub" | "link-email-user" | "none";
	user: AppUserRecord | null;
}

const NO_CAPABILITIES: MailboxCapabilities = {
	readMail: false,
	mutateMail: false,
	sendMail: false,
	manageMailbox: false,
	manageMembers: false,
	manageTemplates: false,
	useTemplates: false,
	manageAi: false,
	useAi: false,
};

const VIEWER_CAPABILITIES: MailboxCapabilities = {
	readMail: true,
	mutateMail: false,
	sendMail: false,
	manageMailbox: false,
	manageMembers: false,
	manageTemplates: false,
	useTemplates: false,
	manageAi: false,
	useAi: false,
};

const RESPONDER_CAPABILITIES: MailboxCapabilities = {
	readMail: true,
	mutateMail: true,
	sendMail: true,
	manageMailbox: false,
	manageMembers: false,
	manageTemplates: false,
	useTemplates: true,
	manageAi: false,
	useAi: true,
};

const MANAGER_CAPABILITIES: MailboxCapabilities = {
	readMail: true,
	mutateMail: true,
	sendMail: true,
	manageMailbox: true,
	manageMembers: true,
	manageTemplates: true,
	useTemplates: true,
	manageAi: true,
	useAi: true,
};

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function displayNameFromEmail(email: string): string {
	const localPart = email.split("@")[0]?.trim();
	return localPart || email;
}

export function getCapabilitiesForRole(role: EffectiveRole): MailboxCapabilities {
	switch (role) {
		case "admin":
		case "manager":
			return { ...MANAGER_CAPABILITIES };
		case "responder":
			return { ...RESPONDER_CAPABILITIES };
		case "viewer":
			return { ...VIEWER_CAPABILITIES };
		case "none":
			return { ...NO_CAPABILITIES };
	}
}

export function resolveAccessUser(
	identity: AccessIdentity,
	userBySub: AppUserRecord | null,
	userByEmail: AppUserRecord | null,
	now: string,
): ResolvedAccessUser {
	const email = normalizeEmail(identity.email);
	if (userBySub) {
		return {
			action: "matched-sub",
			user: {
				...userBySub,
				email,
				updatedAt: now,
				lastLoginAt: now,
			},
		};
	}
	if (userByEmail) {
		return {
			action: "link-email-user",
			user: {
				...userByEmail,
				email,
				accessSub: identity.sub,
				updatedAt: now,
				lastLoginAt: now,
			},
		};
	}
	return { action: "none", user: null };
}

export function buildPendingRegistration(
	identity: AccessIdentity,
	id: string,
	now: string,
): AppUserRecord {
	const email = normalizeEmail(identity.email);
	return {
		id,
		email,
		accessSub: identity.sub,
		status: "pending",
		globalRole: "none",
		displayName: displayNameFromEmail(email),
		createdAt: now,
		updatedAt: now,
		lastLoginAt: now,
	};
}

export function canGenerateAiDraft(
	capabilities: MailboxCapabilities,
	settings: AiDraftGateSettings,
): boolean {
	return settings.enabled && capabilities.sendMail && capabilities.useAi;
}
