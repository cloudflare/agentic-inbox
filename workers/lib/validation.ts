// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import type { z } from "zod";

type ParsedJsonBody<T> =
	| { success: true; data: T }
	| { success: false; response: Response };

export async function parseJsonBody<T>(
	c: Context,
	schema: z.ZodType<T>,
): Promise<ParsedJsonBody<T>> {
	const json = await c.req.json().catch(() => undefined);
	const parsed = schema.safeParse(json);

	if (!parsed.success) {
		return {
			success: false,
			response: c.json({
				error: "Invalid request body",
				details: parsed.error.flatten(),
			}, 400),
		};
	}

	return { success: true, data: parsed.data };
}
