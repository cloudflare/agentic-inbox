// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Centralised query key factories for cache invalidation. */
export const queryKeys = {
	mailboxes: {
		all: ["mailboxes"] as const,
		detail: (id: string) => ["mailboxes", id] as const,
	},
	emails: {
		list: (mailboxId: string, params: Record<string, string>) =>
			["emails", mailboxId, params] as const,
		detail: (mailboxId: string, emailId: string) =>
			["emails", mailboxId, emailId] as const,
		thread: (mailboxId: string, threadId: string) =>
			["emails", mailboxId, "thread", threadId] as const,
	},
	folders: {
		list: (mailboxId: string) => ["folders", mailboxId] as const,
	},
	search: {
		results: (mailboxId: string, query: string, page: number) =>
			["search", mailboxId, query, page] as const,
	},
	memory: {
		list: (mailboxId: string) => ["memory", mailboxId] as const,
		search: (mailboxId: string, query: string) =>
			["memory", mailboxId, "search", query] as const,
		detail: (mailboxId: string, id: string) =>
			["memory", mailboxId, "detail", id] as const,
		context: (mailboxId: string, query: string) =>
			["memory", mailboxId, "context", query] as const,
		facts: (mailboxId: string, status?: string) =>
			["memory", mailboxId, "facts", status ?? "all"] as const,
	},
	templates: {
		list: (mailboxId: string) => ["templates", mailboxId] as const,
	},
	rosters: {
		list: (mailboxId: string) => ["rosters", mailboxId] as const,
		students: (mailboxId: string, rosterId: string) =>
			["rosters", mailboxId, rosterId, "students"] as const,
	},
	config: ["config"] as const,
	productivity: {
		briefing: (mailboxId: string) => ["productivity", mailboxId, "briefing"] as const,
		accounts: (mailboxId: string) => ["productivity", mailboxId, "accounts"] as const,
		extractions: (mailboxId: string) => ["productivity", mailboxId, "extractions"] as const,
		snapshot: (mailboxId: string) => ["productivity", mailboxId, "snapshot"] as const,
		topics: (mailboxId: string) => ["productivity", mailboxId, "topics"] as const,
	},
};
