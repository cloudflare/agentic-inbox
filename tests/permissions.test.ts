import { describe, expect, test } from "bun:test";
import {
	buildPendingRegistration,
	canGenerateAiDraft,
	getCapabilitiesForRole,
	resolveAccessUser,
} from "../workers/lib/permissions";

const NOW = "2026-06-05T09:00:00.000Z";

describe("permission hierarchy", () => {
	test("global admin has every mailbox capability", () => {
		expect(getCapabilitiesForRole("admin")).toEqual({
			readMail: true,
			mutateMail: true,
			sendMail: true,
			manageMailbox: true,
			manageMembers: true,
			manageTemplates: true,
			useTemplates: true,
			manageAi: true,
			useAi: true,
		});
	});

	test("mailbox roles descend from manager to responder to viewer", () => {
		expect(getCapabilitiesForRole("manager")).toEqual({
			readMail: true,
			mutateMail: true,
			sendMail: true,
			manageMailbox: true,
			manageMembers: true,
			manageTemplates: true,
			useTemplates: true,
			manageAi: true,
			useAi: true,
		});
		expect(getCapabilitiesForRole("responder")).toEqual({
			readMail: true,
			mutateMail: true,
			sendMail: true,
			manageMailbox: false,
			manageMembers: false,
			manageTemplates: false,
			useTemplates: true,
			manageAi: false,
			useAi: true,
		});
		expect(getCapabilitiesForRole("viewer")).toEqual({
			readMail: true,
			mutateMail: false,
			sendMail: false,
			manageMailbox: false,
			manageMembers: false,
			manageTemplates: false,
			useTemplates: false,
			manageAi: false,
			useAi: false,
		});
	});
});

describe("Access identity registration", () => {
	test("manual seeded admin links by verified email on first Access login", () => {
		const resolved = resolveAccessUser(
			{ sub: "access-user-1", email: "Admin@Example.COM" },
			null,
			{
				id: "seed-admin",
				email: "admin@example.com",
				accessSub: null,
				status: "active",
				globalRole: "admin",
				displayName: "Admin",
				createdAt: NOW,
				updatedAt: NOW,
				lastLoginAt: null,
			},
			NOW,
		);

		expect(resolved.action).toBe("link-email-user");
		expect(resolved.user).toMatchObject({
			id: "seed-admin",
			email: "admin@example.com",
			accessSub: "access-user-1",
			status: "active",
			globalRole: "admin",
			lastLoginAt: NOW,
		});
	});

	test("unknown Access identity gets a pending registration row", () => {
		const pending = buildPendingRegistration(
			{ sub: "access-user-2", email: "new-user@example.com" },
			"user-id-1",
			NOW,
		);

		expect(pending).toEqual({
			id: "user-id-1",
			email: "new-user@example.com",
			accessSub: "access-user-2",
			status: "pending",
			globalRole: "none",
			displayName: "new-user",
			createdAt: NOW,
			updatedAt: NOW,
			lastLoginAt: NOW,
		});
	});
});

describe("AI draft gating", () => {
	test("AI draft is allowed only when mailbox AI is enabled and role can respond", () => {
		expect(canGenerateAiDraft(getCapabilitiesForRole("responder"), { enabled: true })).toBe(true);
		expect(canGenerateAiDraft(getCapabilitiesForRole("viewer"), { enabled: true })).toBe(false);
		expect(canGenerateAiDraft(getCapabilitiesForRole("manager"), { enabled: false })).toBe(false);
	});
});
