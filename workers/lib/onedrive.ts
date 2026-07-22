// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/MIT

import type { Env } from "../types";
import { resolveSourceType, type MemorySourceType } from "./memory-upload";

interface OneDriveItem {
	id: string;
	name: string;
	webUrl?: string;
	file?: { mimeType?: string };
	"@microsoft.graph.downloadUrl"?: string;
}

async function accessToken(env: Env): Promise<string> {
	if (!env.MICROSOFT_TENANT_ID || !env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) {
		throw new Error("OneDrive Microsoft Graph credentials are not configured");
	}
	const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.MICROSOFT_TENANT_ID)}/oauth2/v2.0/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.MICROSOFT_CLIENT_ID,
			client_secret: env.MICROSOFT_CLIENT_SECRET,
			grant_type: "client_credentials",
			scope: "https://graph.microsoft.com/.default",
		}),
	});
	if (!response.ok) throw new Error(`Microsoft token exchange failed (${response.status})`);
	const data = await response.json<{ access_token?: string }>();
	if (!data.access_token) throw new Error("Microsoft token exchange returned no access token");
	return data.access_token;
}

export interface OneDriveImportFile {
	item: OneDriveItem;
	file: File;
	sourceType: MemorySourceType;
}

/** Download one explicitly selected OneDrive item for the shared memory pipeline. */
export async function getOneDriveFile(env: Env, itemId: string): Promise<OneDriveImportFile> {
	if (!env.ONEDRIVE_USER_ID) throw new Error("ONEDRIVE_USER_ID is not configured");
	const token = await accessToken(env);
	const headers = { Authorization: `Bearer ${token}` };
	const metadataResponse = await fetch(
		`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.ONEDRIVE_USER_ID)}/drive/items/${encodeURIComponent(itemId)}?$select=id,name,webUrl,file,@microsoft.graph.downloadUrl`,
		{ headers },
	);
	if (!metadataResponse.ok) throw new Error(`OneDrive metadata request failed (${metadataResponse.status})`);
	const item = await metadataResponse.json<OneDriveItem>();
	if (!item.file || !item.name) throw new Error("The selected OneDrive item is not a file");
	const sourceType = resolveSourceType(item.file.mimeType || "", item.name);
	if (!sourceType) throw new Error(`Unsupported OneDrive file type: ${item.file.mimeType || item.name}`);

	const downloadUrl = item["@microsoft.graph.downloadUrl"];
	if (!downloadUrl) throw new Error("OneDrive did not return a download URL");
	const contentResponse = await fetch(downloadUrl);
	if (!contentResponse.ok) throw new Error(`OneDrive content request failed (${contentResponse.status})`);
	const content = await contentResponse.arrayBuffer();
	return {
		item,
		file: new File([content], item.name, { type: item.file.mimeType || "application/octet-stream" }),
		sourceType,
	};
}
