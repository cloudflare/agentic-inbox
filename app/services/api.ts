// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { DraftContextPack, Email, Folder, Mailbox, MemoryEntry, MemoryFact, MemoryFileDetail, MemorySearchResponse, Roster, Student, Template } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		// FormData bodies must let the browser set their own multipart
		// Content-Type (with boundary) — forcing application/json here would
		// break the upload.
		const isFormData = options.body instanceof FormData;
		const res = await fetch(url, {
			...options,
			signal,
			headers: isFormData
				? (options.headers as Record<string, string>)
				: {
						"Content-Type": "application/json",
						...(options.headers as Record<string, string>),
					},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[]; openRouterConfigured: boolean }>("/api/v1/config"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	bulkMarkRead: (mailboxId: string, ids: string[], read: boolean) =>
		post<{ updated: number }>(`/api/v1/mailboxes/${mailboxId}/emails/bulk-mark-read`, { ids, read }),
	bulkMoveEmails: (mailboxId: string, ids: string[], folderId: string) =>
		post<{ moved: number }>(`/api/v1/mailboxes/${mailboxId}/emails/bulk-move`, { ids, folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) => post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),

	// AI
	rewriteEmailBody: (mailboxId: string, body: string, action: string, instruction?: string) =>
		post<{ body: string }>(`/api/v1/mailboxes/${mailboxId}/ai/rewrite`, { body, action, instruction }),

	// Memory
	listMemory: (mailboxId: string) =>
		get<MemoryEntry[]>(`/api/v1/mailboxes/${mailboxId}/memory`),
	addMemory: (mailboxId: string, data: { title: string; content: string; tags?: string }) =>
		post<MemoryEntry>(`/api/v1/mailboxes/${mailboxId}/memory`, data),
	deleteMemory: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/memory/${id}`),
	searchMemory: (mailboxId: string, query: string) =>
		get<MemorySearchResponse>(`/api/v1/mailboxes/${mailboxId}/memory/search`, { params: { query } }),
	getMemoryContext: (mailboxId: string, query: string) =>
		get<DraftContextPack>(`/api/v1/mailboxes/${mailboxId}/memory/context`, { params: { query } }),
	listMemoryFacts: (mailboxId: string, status?: string) =>
		get<MemoryFact[]>(`/api/v1/mailboxes/${mailboxId}/memory/facts`, { params: status ? { status } : undefined }),
	updateMemoryFactStatus: (mailboxId: string, id: string, status: MemoryFact["status"]) =>
		post<{ status: string }>(`/api/v1/mailboxes/${mailboxId}/memory/facts/${id}/status`, { status }),
	updateMemoryFact: (mailboxId: string, id: string, data: { kind?: string; value?: string }) =>
		put<{ updated: boolean }>(`/api/v1/mailboxes/${mailboxId}/memory/facts/${id}`, data),
	uploadMemory: (mailboxId: string, file: File, title?: string, tags?: string) => {
		const formData = new FormData();
		formData.append("file", file);
		if (title) formData.append("title", title);
		if (tags) formData.append("tags", tags);
		return request<MemoryEntry>(`/api/v1/mailboxes/${mailboxId}/memory/upload`, {
			method: "POST",
			body: formData,
		});
	},
	importGoogleDrive: (mailboxId: string, fileIds: string[], parentId?: string) =>
		post<{ imported: MemoryEntry[]; skipped: string[] }>(`/api/v1/mailboxes/${mailboxId}/memory/import/google-drive`, { fileIds, parentId }),
	importOneDrive: (mailboxId: string, fileIds: string[], parentId?: string) =>
		post<{ imported: MemoryEntry[]; skipped: string[] }>(`/api/v1/mailboxes/${mailboxId}/memory/import/onedrive`, { fileIds, parentId }),
	getMemory: (mailboxId: string, id: string) =>
		get<MemoryFileDetail>(`/api/v1/mailboxes/${mailboxId}/memory/${id}`),
	updateMemory: (mailboxId: string, id: string, data: { title?: string; tags?: string; parent_id?: string; draft_eligible?: boolean }) =>
		put<MemoryEntry>(`/api/v1/mailboxes/${mailboxId}/memory/${id}`, data),
	summarizeMemory: (mailboxId: string, id: string) =>
		post<{ summary: string }>(`/api/v1/mailboxes/${mailboxId}/memory/${id}/summarize`),

	// Templates
	listTemplates: (mailboxId: string) =>
		get<Template[]>(`/api/v1/mailboxes/${mailboxId}/templates`),
	createTemplate: (mailboxId: string, data: { title: string; body: string; tags?: string }) =>
		post<Template>(`/api/v1/mailboxes/${mailboxId}/templates`, data),
	updateTemplate: (mailboxId: string, id: string, data: { title?: string; body?: string; tags?: string }) =>
		put<Template>(`/api/v1/mailboxes/${mailboxId}/templates/${id}`, data),
	deleteTemplate: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/templates/${id}`),

	// Rosters
	listRosters: (mailboxId: string) =>
		get<Roster[]>(`/api/v1/mailboxes/${mailboxId}/rosters`),
	createRoster: (mailboxId: string, data: { name: string; students: { name?: string; email: string }[] }) =>
		post<Roster>(`/api/v1/mailboxes/${mailboxId}/rosters`, data),
	listStudents: (mailboxId: string, rosterId: string) =>
		get<Student[]>(`/api/v1/mailboxes/${mailboxId}/rosters/${rosterId}/students`),
	deleteRoster: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/rosters/${id}`),
};

export default api;
