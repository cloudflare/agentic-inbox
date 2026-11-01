// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export { MailboxDO } from "../../workers/durableObject/index.ts";

export default {
	async fetch(request, env) {
		const { method, args } = await request.json();
		const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName("test"));
		try {
			return Response.json({ result: await mailbox[method](...args) });
		} catch (error) {
			return Response.json({ error: String(error) }, { status: 500 });
		}
	},
};
