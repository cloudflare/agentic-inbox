// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

export const MICROSOFT_SCOPES = [
	"openid", "profile", "email", "offline_access", "User.Read",
	"Mail.ReadWrite", "Calendars.ReadWrite", "Contacts.ReadWrite", "Tasks.ReadWrite",
].join(" ");

export function microsoftOAuthUrl(env: Env, state: string): string {
	if (!env.MICROSOFT_CLIENT_ID) throw new Error("MICROSOFT_CLIENT_ID is not configured");
	const tenant = env.MICROSOFT_TENANT_ID || "common";
	const redirect = env.MICROSOFT_REDIRECT_URI || "/auth/microsoft/callback";
	const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
	url.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", new URL(redirect, env.APP_ORIGIN || "http://localhost").toString());
	url.searchParams.set("response_mode", "query");
	url.searchParams.set("scope", MICROSOFT_SCOPES);
	url.searchParams.set("state", state);
	return url.toString();
}

export async function exchangeMicrosoftCode(env: Env, code: string): Promise<Record<string, unknown>> {
	if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) throw new Error("Microsoft OAuth is not configured");
	const tenant = env.MICROSOFT_TENANT_ID || "common";
	const redirect = env.MICROSOFT_REDIRECT_URI || "/auth/microsoft/callback";
	const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.MICROSOFT_CLIENT_ID,
			client_secret: env.MICROSOFT_CLIENT_SECRET,
			code,
			redirect_uri: new URL(redirect, env.APP_ORIGIN || "http://localhost").toString(),
			grant_type: "authorization_code",
			scope: MICROSOFT_SCOPES,
		}),
	});
	if (!response.ok) throw new Error(`Microsoft token exchange failed (${response.status})`);
	return normalizeMicrosoftToken(await response.json() as Record<string, unknown>);
}

export function normalizeMicrosoftToken(token: Record<string, unknown>): Record<string, unknown> {
	const expiresIn = Number(token.expires_in || 3600);
	return { ...token, expires_at: Date.now() + Math.max(expiresIn - 60, 60) * 1000 };
}

export async function refreshMicrosoftToken(env: Env, refreshToken: string): Promise<Record<string, unknown>> {
	if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) throw new Error("Microsoft OAuth is not configured");
	const tenant = env.MICROSOFT_TENANT_ID || "common";
	const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: env.MICROSOFT_CLIENT_ID, client_secret: env.MICROSOFT_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token", scope: MICROSOFT_SCOPES }),
	});
	if (!response.ok) throw new Error(`Microsoft token refresh failed (${response.status})`);
	return normalizeMicrosoftToken(await response.json() as Record<string, unknown>);
}

export interface GraphEmailAddress {
	name?: string;
	address?: string;
}

export interface GraphRecipient {
	emailAddress?: GraphEmailAddress;
}

export interface GraphItemBody {
	contentType?: "text" | "html";
	content?: string;
}

export interface GraphMessage {
	id: string;
	subject?: string;
	from?: GraphRecipient;
	toRecipients?: GraphRecipient[];
	receivedDateTime?: string;
	bodyPreview?: string;
	body?: GraphItemBody;
	isRead?: boolean;
	conversationId?: string;
}

export interface GraphDateTimeTimeZone {
	dateTime: string;
	timeZone: string;
}

export interface GraphPhysicalAddress {
	street?: string;
	city?: string;
	state?: string;
	countryOrRegion?: string;
	postalCode?: string;
}

export interface GraphLocation {
	displayName?: string;
	address?: GraphPhysicalAddress;
}

export interface GraphAttendee {
	type?: "required" | "optional" | "resource";
	status?: {
		response?: string;
		time?: string;
	};
	emailAddress?: GraphEmailAddress;
}

export interface GraphEvent {
	id: string;
	subject?: string;
	bodyPreview?: string;
	body?: GraphItemBody;
	start?: GraphDateTimeTimeZone;
	end?: GraphDateTimeTimeZone;
	location?: GraphLocation;
	organizer?: GraphRecipient;
	attendees?: GraphAttendee[];
	webLink?: string;
	isAllDay?: boolean;
}

export interface CreateGraphEventInput {
	subject: string;
	body?: GraphItemBody;
	start: GraphDateTimeTimeZone;
	end: GraphDateTimeTimeZone;
	location?: GraphLocation;
	attendees?: GraphAttendee[];
	isAllDay?: boolean;
}

export interface ListGraphEventsOptions {
	top?: number;
	startDateTime?: string;
	endDateTime?: string;
}

export interface GraphContactEmailAddress {
	address?: string;
	name?: string;
}

export interface GraphContact {
	id: string;
	displayName?: string;
	givenName?: string;
	surname?: string;
	companyName?: string;
	jobTitle?: string;
	emailAddresses?: GraphContactEmailAddress[];
	businessPhones?: string[];
	homePhones?: string[];
	mobilePhone?: string;
	imAddresses?: string[];
	personalNotes?: string;
}

export interface CreateGraphContactInput {
	displayName?: string;
	givenName?: string;
	surname?: string;
	companyName?: string;
	jobTitle?: string;
	emailAddresses?: GraphContactEmailAddress[];
	businessPhones?: string[];
	homePhones?: string[];
	mobilePhone?: string;
	imAddresses?: string[];
	personalNotes?: string;
}

export type GraphTodoTaskStatus =
	| "notStarted"
	| "inProgress"
	| "completed"
	| "waitingOnOthers"
	| "deferred";

export type GraphTodoTaskImportance = "low" | "normal" | "high";

export interface GraphTodoItemBody {
	content?: string;
	contentType?: "text" | "html";
}

export interface GraphTodoTask {
	id: string;
	title?: string;
	status?: GraphTodoTaskStatus;
	importance?: GraphTodoTaskImportance;
	body?: GraphTodoItemBody;
	startDateTime?: GraphDateTimeTimeZone;
	dueDateTime?: GraphDateTimeTimeZone;
	completedDateTime?: GraphDateTimeTimeZone;
	createdDateTime?: string;
	lastModifiedDateTime?: string;
}

export interface CreateGraphTodoTaskInput {
	title: string;
	status?: GraphTodoTaskStatus;
	importance?: GraphTodoTaskImportance;
	body?: GraphTodoItemBody;
	startDateTime?: GraphDateTimeTimeZone;
	dueDateTime?: GraphDateTimeTimeZone;
}

export interface GraphTodoTaskList {
	id: string;
	displayName?: string;
	wellknownListName?: string;
	isOwner?: boolean;
	isShared?: boolean;
}

export interface ListGraphTodoTasksOptions {
	listId?: string;
	top?: number;
	includeCompleted?: boolean;
}

export interface GraphTodoTaskResult {
	listId: string;
	task: GraphTodoTask;
}

export interface GraphTodoTaskListResult {
	listId: string;
	tasks: GraphTodoTask[];
}

export interface GraphSubscription {
	id: string;
	resource: string;
	expirationDateTime: string;
	applicationId?: string;
	changeType?: string;
	clientState?: string;
	notificationUrl?: string;
}

interface GraphCollection<T> {
	value?: T[];
}

function clampTop(top = 25, max = 50): number {
	return Math.min(Math.max(top, 1), max);
}

function graphUrl(path: string): URL {
	return new URL(path.replace(/^\/+/, ""), `${GRAPH_BASE_URL}/`);
}

async function graphRequest<T>(
	accessToken: string,
	path: string | URL,
	init: RequestInit = {},
	errorLabel = "Microsoft Graph request failed",
): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set("Accept", "application/json");
	if (init.body && !headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}

	const response = await fetch(path, { ...init, headers });
	if (!response.ok) {
		throw new Error(`${errorLabel} (${response.status})`);
	}
	return await response.json() as T;
}

export async function listGraphMessages(accessToken: string, top = 25): Promise<GraphMessage[]> {
	const url = graphUrl("/me/mailFolders/inbox/messages");
	url.searchParams.set("$top", String(clampTop(top)));
	url.searchParams.set("$orderby", "receivedDateTime desc");
	url.searchParams.set("$select", "id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isRead,conversationId");
	const data = await graphRequest<GraphCollection<GraphMessage>>(
		accessToken,
		url,
		{ headers: { Prefer: "outlook.body-content-type=\"text\"" } },
		"Microsoft message sync failed",
	);
	return data.value ?? [];
}

export async function listGraphEvents(
	accessToken: string,
	options: ListGraphEventsOptions = {},
): Promise<GraphEvent[]> {
	const top = clampTop(options.top);
	const url = options.startDateTime && options.endDateTime
		? graphUrl("/me/calendarView")
		: graphUrl("/me/events");

	url.searchParams.set("$top", String(top));
	url.searchParams.set(
		"$select",
		"id,subject,bodyPreview,body,start,end,location,organizer,attendees,webLink,isAllDay",
	);

	if (options.startDateTime && options.endDateTime) {
		url.searchParams.set("startDateTime", options.startDateTime);
		url.searchParams.set("endDateTime", options.endDateTime);
	} else {
		url.searchParams.set("$orderby", "start/dateTime");
	}

	const data = await graphRequest<GraphCollection<GraphEvent>>(
		accessToken,
		url,
		{},
		"Microsoft event sync failed",
	);
	return data.value ?? [];
}

export async function createGraphEvent(
	accessToken: string,
	input: CreateGraphEventInput,
): Promise<GraphEvent> {
	return graphRequest<GraphEvent>(
		accessToken,
		graphUrl("/me/events"),
		{
			method: "POST",
			body: JSON.stringify(input),
		},
		"Microsoft event create failed",
	);
}

export async function listGraphContacts(accessToken: string, top = 25): Promise<GraphContact[]> {
	const url = graphUrl("/me/contacts");
	url.searchParams.set("$top", String(clampTop(top)));
	url.searchParams.set(
		"$select",
		"id,displayName,givenName,surname,companyName,jobTitle,emailAddresses,businessPhones,homePhones,mobilePhone,imAddresses,personalNotes",
	);

	const data = await graphRequest<GraphCollection<GraphContact>>(
		accessToken,
		url,
		{},
		"Microsoft contact sync failed",
	);
	return data.value ?? [];
}

export async function createGraphContact(
	accessToken: string,
	input: CreateGraphContactInput,
): Promise<GraphContact> {
	return graphRequest<GraphContact>(
		accessToken,
		graphUrl("/me/contacts"),
		{
			method: "POST",
			body: JSON.stringify(input),
		},
		"Microsoft contact create failed",
	);
}

export async function listGraphTodoTaskLists(
	accessToken: string,
	top = 25,
): Promise<GraphTodoTaskList[]> {
	const url = graphUrl("/me/todo/lists");
	url.searchParams.set("$top", String(clampTop(top)));
	url.searchParams.set(
		"$select",
		"id,displayName,wellknownListName,isOwner,isShared",
	);

	const data = await graphRequest<GraphCollection<GraphTodoTaskList>>(
		accessToken,
		url,
		{},
		"Microsoft To Do list sync failed",
	);
	return data.value ?? [];
}

async function resolveGraphTodoListId(
	accessToken: string,
	listId?: string,
): Promise<string> {
	if (listId) return listId;
	const lists = await listGraphTodoTaskLists(accessToken, 50);
	const preferred = lists.find((list) => list.wellknownListName === "defaultList") ?? lists[0];
	if (!preferred?.id) {
		throw new Error("Microsoft To Do has no available task lists");
	}
	return preferred.id;
}

export async function listGraphTodoTasks(
	accessToken: string,
	options: ListGraphTodoTasksOptions = {},
): Promise<GraphTodoTaskListResult> {
	const listId = await resolveGraphTodoListId(accessToken, options.listId);
	const url = graphUrl(`/me/todo/lists/${encodeURIComponent(listId)}/tasks`);
	url.searchParams.set("$top", String(clampTop(options.top)));
	url.searchParams.set(
		"$select",
		"id,title,status,importance,body,startDateTime,dueDateTime,completedDateTime,createdDateTime,lastModifiedDateTime",
	);
	if (!options.includeCompleted) {
		url.searchParams.set("$filter", "status ne 'completed'");
	}

	const data = await graphRequest<GraphCollection<GraphTodoTask>>(
		accessToken,
		url,
		{},
		"Microsoft To Do task sync failed",
	);
	return {
		listId,
		tasks: data.value ?? [],
	};
}

export async function createGraphTodoTask(
	accessToken: string,
	input: CreateGraphTodoTaskInput,
	options: { listId?: string } = {},
): Promise<GraphTodoTaskResult> {
	const listId = await resolveGraphTodoListId(accessToken, options.listId);
	const task = await graphRequest<GraphTodoTask>(
		accessToken,
		graphUrl(`/me/todo/lists/${encodeURIComponent(listId)}/tasks`),
		{
			method: "POST",
			body: JSON.stringify(input),
		},
		"Microsoft To Do task create failed",
	);
	return { listId, task };
}

export async function createGraphSubscription(
	accessToken: string,
	resource: string,
	notificationUrl: string,
	clientState: string,
	options: { expirationMinutes?: number; changeType?: string } = {},
): Promise<GraphSubscription> {
	const expirationMinutes = Math.min(Math.max(options.expirationMinutes ?? 120, 15), 4230);
	const expirationDateTime = new Date(
		Date.now() + expirationMinutes * 60 * 1000,
	).toISOString();

	return graphRequest<GraphSubscription>(
		accessToken,
		graphUrl("/subscriptions"),
		{
			method: "POST",
				body: JSON.stringify({
					changeType: options.changeType ?? "created,updated,deleted",
					notificationUrl,
					lifecycleNotificationUrl: notificationUrl,
					resource,
					expirationDateTime,
					clientState,
				}),
			},
			"Microsoft subscription create failed",
	);
}

export async function renewGraphSubscription(accessToken: string, id: string): Promise<{ id: string; expirationDateTime: string }> {
	const expirationDateTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	return graphRequest(accessToken, graphUrl(`/subscriptions/${encodeURIComponent(id)}`), {
		method: "PATCH",
		body: JSON.stringify({ expirationDateTime }),
	}, "Microsoft subscription renewal failed");
}
