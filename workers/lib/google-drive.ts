// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { importPKCS8, SignJWT } from "jose";
import type { Env } from "../types";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

async function accessToken(env: Env): Promise<string> {
	if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
		throw new Error("Google Drive service account is not configured");
	}
	const key = await importPKCS8(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"), "RS256");
	const now = Math.floor(Date.now() / 1000);
	const assertion = await new SignJWT({ scope: DRIVE_SCOPE })
		.setProtectedHeader({ alg: "RS256", typ: "JWT" })
		.setIssuer(env.GOOGLE_SERVICE_ACCOUNT_EMAIL)
		.setAudience("https://oauth2.googleapis.com/token")
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(key);
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
	});
	if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
	const data = await response.json<{ access_token?: string }>();
	if (!data.access_token) throw new Error("Google token exchange returned no access token");
	return data.access_token;
}

export interface GoogleDriveFile {
	id: string;
	name: string;
	mimeType: string;
	webViewLink?: string;
	modifiedTime?: string;
}

export async function getDriveFile(env: Env, fileId: string): Promise<{ file: GoogleDriveFile; content: string; sourceType: "text" | "markdown" }> {
	const token = await accessToken(env);
	const headers = { Authorization: `Bearer ${token}` };
	const metadataResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink,modifiedTime`, { headers });
	if (!metadataResponse.ok) throw new Error(`Google Drive metadata request failed (${metadataResponse.status})`);
	const file = await metadataResponse.json<GoogleDriveFile>();
	const exportTypes: Record<string, string> = {
		"application/vnd.google-apps.document": "text/markdown",
		"application/vnd.google-apps.spreadsheet": "text/csv",
		"application/vnd.google-apps.presentation": "text/plain",
	};
	if (!exportTypes[file.mimeType] && !file.mimeType.startsWith("text/")) {
		throw new Error(`Unsupported Google Drive type for import: ${file.mimeType}`);
	}
	const url = exportTypes[file.mimeType]
		? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportTypes[file.mimeType])}`
		: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
	const contentResponse = await fetch(url, { headers });
	if (!contentResponse.ok) throw new Error(`Google Drive content request failed (${contentResponse.status})`);
	return {
		file,
		content: await contentResponse.text(),
		sourceType: file.mimeType === "text/markdown" || file.name.toLowerCase().endsWith(".md") ? "markdown" : "text",
	};
}
