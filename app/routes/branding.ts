import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getSessionUser } from "../../workers/lib/auth";
import type { Env } from "../../workers/types";

const BRANDING_KEY = "system/app-name";
const DEFAULT_APP_NAME = "Agentic Inbox";

type Context = { cloudflare: { env: Env } };

export async function loader({ context }: LoaderFunctionArgs) {
	const env = (context as unknown as Context).cloudflare.env;
	const stored = await env.BUCKET.get(BRANDING_KEY);
	const appName = stored ? (await stored.text()).trim() : "";
	return Response.json({ appName: appName || (env.APP_NAME || DEFAULT_APP_NAME).trim() || DEFAULT_APP_NAME });
}

export async function action({ request, context }: ActionFunctionArgs) {
	const env = (context as unknown as Context).cloudflare.env;
	const user = await getSessionUser(env, request);
	if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
	if (user.role !== "admin") return Response.json({ error: "Administrator permission required" }, { status: 403 });
	if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
	const body = await request.json().catch(() => null) as { appName?: unknown } | null;
	const appName = String(body?.appName ?? "").trim();
	if (!appName) return Response.json({ error: "Brand name is required" }, { status: 400 });
	if (appName.length > 80) return Response.json({ error: "Brand name is too long" }, { status: 400 });
	await env.BUCKET.put(BRANDING_KEY, appName);
	return Response.json({ appName });
}
