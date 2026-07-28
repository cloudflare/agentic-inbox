import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { requireMailbox, type MailboxContext } from "../lib/mailbox.ts";
import { attachmentUploadRoutes } from "../routes/attachment-uploads.ts";

export class AttachmentUploadTestMailboxDO {
	constructor(_state: DurableObjectState) {}

	fetch(): Response {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
}

const app = new Hono<MailboxContext>();
app.use("*", async (c, next) => {
	const user = c.req.header("x-test-user");
	if (user === "member" || user === "nonmember" || user === "admin") {
		const session: SessionClaims = {
			sub: user,
			email: `${user}@example.com`,
			role: user === "admin" ? "ADMIN" : "AGENT",
			mailbox: `${user}@example.com`,
			sessionVersion: 1,
		};
		c.set("session", session);
	}
	await next();
});
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
app.route("/", attachmentUploadRoutes);

export default app;
