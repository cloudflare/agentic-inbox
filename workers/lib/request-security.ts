const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * What the workers.dev hostname is allowed to serve.
 *
 * It exists for exactly one caller: AWS EventBridge posts SES events there
 * because Bot Fight Mode on the zone challenges them on mail.wiserchat.ai and
 * supports no exceptions on this plan. Requests to workers.dev never traverse
 * the zone's security config, so nothing else may be reachable on it - the
 * portal, its API, its auth pages and the OAuth/MCP surface all stay on the
 * zone hostname. Zone hosts are untouched by this decision.
 */
export function workersDevRequestDecision(
	request: Request,
): "allow" | "not-found" {
	const url = new URL(request.url);
	if (!url.hostname.endsWith(".workers.dev")) return "allow";
	return request.method.toUpperCase() === "POST" &&
		url.pathname === "/webhooks/ses"
		? "allow"
		: "not-found";
}

/**
 * Origin policy for browser routes authenticated by the session cookie.
 *
 * The SES callback is excluded because it has a dedicated bearer credential.
 * OAuth token and MCP endpoints are handled by OAuthProvider before this app.
 */
export function mutationOriginDecision(request: Request): "allow" | "forbid" {
	if (SAFE_METHODS.has(request.method.toUpperCase())) return "allow";

	const url = new URL(request.url);
	if (url.pathname === "/webhooks/ses") return "allow";

	const origin = request.headers.get("origin");
	if (origin) return origin === url.origin ? "allow" : "forbid";

	const referer = request.headers.get("referer");
	if (referer) {
		try {
			return new URL(referer).origin === url.origin ? "allow" : "forbid";
		} catch {
			return "forbid";
		}
	}

	return request.headers.get("sec-fetch-site") === "same-origin"
		? "allow"
		: "forbid";
}
