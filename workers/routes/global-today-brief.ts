import { Hono } from "hono";
import { z } from "zod";
import type { SessionClaims } from "../lib/auth.ts";
import {
	createGlobalTodayBriefRuntime,
	globalTodayBriefFailureCode,
	GlobalTodayBriefAccessChangedError,
	runGlobalTodayBrief,
} from "../lib/global-today-brief-runtime.ts";
import type { GlobalTodayBriefResponse } from "../../shared/global-today-brief.ts";
import type { TodayBriefDayBoundary } from "../lib/today-brief-timezone.ts";
import { resolveTodayBriefDay } from "../lib/today-brief-timezone.ts";
import type { Env } from "../types.ts";
import {
	LiveReadAuthorizationError,
	LiveReadAuthorizationUnavailableError,
	LiveReadSessionAuthorizationError,
} from "../lib/live-authorized-read.ts";
import {
	loadExactLiveMailboxRoster,
	runExactLiveMailboxRosterRead,
	type ExactLiveMailboxRosterLoader,
} from "../lib/live-mailbox-authorization.ts";

const REQUEST_BYTES = 1_024;
const requestSchema = z.object({
	timeZone: z.string().trim().min(1).max(100),
	refresh: z.literal(true).optional(),
}).strict();

export type GlobalTodayBriefRouteContext = {
	Bindings: Env;
	Variables: { session?: SessionClaims };
};

export type GlobalTodayBriefRouteInput = {
	env: Env;
	actorUserId: string;
	day: TodayBriefDayBoundary;
	refresh: boolean;
};

export type GlobalTodayBriefRouteDependencies = {
	run(input: GlobalTodayBriefRouteInput): Promise<unknown>;
};

const productionDependencies: GlobalTodayBriefRouteDependencies = {
	run: (input) => runGlobalTodayBrief(
		createGlobalTodayBriefRuntime(input.env, input),
		{
			actorUserId: input.actorUserId,
			day: input.day,
			refresh: input.refresh,
			requestScope: `${input.day.localDate}:${input.day.timeZone}:${input.refresh ? "refresh" : "automatic"}`,
		},
	),
};

class BodyError extends Error {
	readonly tooLarge: boolean;
	constructor(tooLarge = false) {
		super(tooLarge ? "Global Today brief request is too large" : "Global Today brief request is invalid");
		this.tooLarge = tooLarge;
	}
}

async function boundedJsonBody(request: Request): Promise<unknown> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (Number.isFinite(parsed) && parsed > REQUEST_BYTES) throw new BodyError(true);
	}
	if (!request.body) throw new BodyError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > REQUEST_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new BodyError(true);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new BodyError();
	}
}

export function createGlobalTodayBriefRoutes(
	dependencies: GlobalTodayBriefRouteDependencies = productionDependencies,
	loadRoster: ExactLiveMailboxRosterLoader = loadExactLiveMailboxRoster,
) {
	const app = new Hono<GlobalTodayBriefRouteContext>();
	app.post("/api/v1/today/brief", async (c) => {
		c.header("Cache-Control", "private, no-store");
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		let day: TodayBriefDayBoundary;
		let refresh: boolean;
		try {
			const parsed = requestSchema.safeParse(await boundedJsonBody(c.req.raw));
			if (!parsed.success) throw new BodyError();
			day = resolveTodayBriefDay(parsed.data.timeZone);
			refresh = parsed.data.refresh ?? false;
		} catch (error) {
			if (error instanceof BodyError && error.tooLarge) return c.json({ error: error.message }, 413);
			return c.json({ error: "Global Today brief request is invalid" }, 400);
		}
		try {
			return c.json(await runExactLiveMailboxRosterRead(
				c.env,
				{
					userId: session.sub,
					sessionVersion: session.sessionVersion,
				},
				() => dependencies.run({
					env: c.env,
					actorUserId: session.sub,
					day,
					refresh,
				}),
				loadRoster,
			));
		} catch (error) {
			if (error instanceof LiveReadSessionAuthorizationError) {
				return c.json({ error: "Unauthorized" }, 401);
			}
			if (error instanceof LiveReadAuthorizationError) {
				return c.json({ error: "Mailbox access changed" }, 403);
			}
			if (error instanceof LiveReadAuthorizationUnavailableError) {
				return c.json({ error: "Authorization unavailable" }, 503);
			}
			if (error instanceof GlobalTodayBriefAccessChangedError) {
				return c.json({ error: "Mailbox access changed" }, 403);
			}
			const errorCode = globalTodayBriefFailureCode(error);
			console.error("[global-today-brief] generation failed", { errorCode });
			// Today stays usable without its brief, so an unusable brief is a
			// degraded state rather than a failed request.
			return c.json({ state: "brief_unavailable", reason: errorCode } satisfies GlobalTodayBriefResponse);
		}
	});
	return app;
}

export const globalTodayBriefRoutes = createGlobalTodayBriefRoutes();
