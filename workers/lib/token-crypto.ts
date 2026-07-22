// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

async function keyFromSecret(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(secret: string | undefined, value: unknown): Promise<string> {
	if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await keyFromSecret(secret);
	const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
	const bytes = new Uint8Array(encrypted);
	const encoded = (data: Uint8Array) => btoa(String.fromCharCode(...data));
	return `${encoded(iv)}.${encoded(bytes)}`;
}

export async function decryptToken(secret: string | undefined, value: string): Promise<string> {
	if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
	const [ivText, encryptedText] = value.split(".");
	if (!ivText || !encryptedText) throw new Error("Invalid encrypted token");
	const decode = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
	const key = await keyFromSecret(secret);
	const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(ivText) }, key, decode(encryptedText));
	return new TextDecoder().decode(decrypted);
}
