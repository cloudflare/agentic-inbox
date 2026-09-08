import { z } from "zod";

export const AgentPermissionSchema = z.enum(["read", "draft", "send"]);
const address = z.string().trim().toLowerCase().email();
export const AgentConfigSchema = z.object({
	name: z.string().trim().min(1).max(80),
	mailboxIds: z.array(address).min(1).max(100).transform(ids => [...new Set(ids)]),
	permissions: z.array(AgentPermissionSchema).min(1).transform(values => [...new Set(values)]),
	sendMode: z.enum(["draft_only", "direct"]),
	enabled: z.boolean(),
	testMode: z.boolean(),
	testRecipient: address.optional(),
	allowedRecipients: z.array(address).max(100),
	maxSendsPerDay: z.number().int().min(1).max(100),
	maxGenerationsPerDay: z.number().int().min(1).max(100),
	verifyOutgoingWithAI: z.boolean(),
}).strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentPermission = z.infer<typeof AgentPermissionSchema>;
export type AgentAccess = AgentConfig & { id: string; createdAt: string; updatedAt: string; revision: string };
export const defaultAgentConfig = (mailboxId: string): AgentConfig => ({
	name: "", mailboxIds: [mailboxId], permissions: ["read", "draft", "send"],
	sendMode: "draft_only", enabled: true, testMode: false, allowedRecipients: [],
	maxSendsPerDay: 20, maxGenerationsPerDay: 20, verifyOutgoingWithAI: false,
});

export interface AgentActivity {
	requestId: string;
	action: string;
	date: string;
	status: string;
	emailId?: string;
}
