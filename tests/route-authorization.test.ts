import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const root = process.cwd();
const workerSource = readFileSync(join(root, "workers/index.ts"), "utf8");
const workerLines = workerSource.split(/\r?\n/);

function routeLine(method: string, route: string): string {
	const line = workerLines.find((candidate) =>
		candidate.includes(`app.${method}(${JSON.stringify(route)}`),
	);
	if (!line) throw new Error(`Missing ${method.toUpperCase()} ${route}`);
	return line;
}

function expectMailboxRoute(method: string, route: string, capability: string): void {
	expect(routeLine(method, route), `${method.toUpperCase()} ${route}`).toContain(
		`requireMailboxPermission("${capability}")`,
	);
}

test("mailbox API routes use capability middleware before mailbox storage access", () => {
	expect(workerSource).not.toContain("requireMailbox(");

	for (const [method, route, capability] of [
		["get", "/api/v1/mailboxes/:mailboxId", "readMail"],
		["put", "/api/v1/mailboxes/:mailboxId", "manageMailbox"],
		["delete", "/api/v1/mailboxes/:mailboxId", "manageMailbox"],
		["get", "/api/v1/mailboxes/:mailboxId/memberships", "manageMembers"],
		["put", "/api/v1/mailboxes/:mailboxId/memberships/:userId", "manageMembers"],
		["delete", "/api/v1/mailboxes/:mailboxId/memberships/:userId", "manageMembers"],
		["get", "/api/v1/mailboxes/:mailboxId/templates", "useTemplates"],
		["post", "/api/v1/mailboxes/:mailboxId/templates", "manageTemplates"],
		["put", "/api/v1/mailboxes/:mailboxId/templates/:templateId", "manageTemplates"],
		["delete", "/api/v1/mailboxes/:mailboxId/templates/:templateId", "manageTemplates"],
		["get", "/api/v1/mailboxes/:mailboxId/ai-settings", "readMail"],
		["put", "/api/v1/mailboxes/:mailboxId/ai-settings", "manageAi"],
		["get", "/api/v1/mailboxes/:mailboxId/emails", "readMail"],
		["post", "/api/v1/mailboxes/:mailboxId/emails", "sendMail"],
		["post", "/api/v1/mailboxes/:mailboxId/drafts", "sendMail"],
		["get", "/api/v1/mailboxes/:mailboxId/emails/:id", "readMail"],
		["post", "/api/v1/mailboxes/:mailboxId/emails/:id/ai-draft", "sendMail"],
		["put", "/api/v1/mailboxes/:mailboxId/emails/:id", "mutateMail"],
		["delete", "/api/v1/mailboxes/:mailboxId/emails/:id", "mutateMail"],
		["post", "/api/v1/mailboxes/:mailboxId/emails/:id/move", "mutateMail"],
		["get", "/api/v1/mailboxes/:mailboxId/threads/:threadId", "readMail"],
		["post", "/api/v1/mailboxes/:mailboxId/threads/:threadId/read", "mutateMail"],
		["post", "/api/v1/mailboxes/:mailboxId/emails/:id/reply", "sendMail"],
		["post", "/api/v1/mailboxes/:mailboxId/emails/:id/forward", "sendMail"],
		["get", "/api/v1/mailboxes/:mailboxId/folders", "readMail"],
		["post", "/api/v1/mailboxes/:mailboxId/folders", "manageMailbox"],
		["put", "/api/v1/mailboxes/:mailboxId/folders/:id", "manageMailbox"],
		["delete", "/api/v1/mailboxes/:mailboxId/folders/:id", "manageMailbox"],
		["get", "/api/v1/mailboxes/:mailboxId/search", "readMail"],
		["get", "/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", "readMail"],
	]) {
		expectMailboxRoute(method, route, capability);
	}
});

test("inbound mail checks the active APP_DB mailbox registry before DO storage", () => {
	const receiveStart = workerSource.indexOf("async function receiveEmail");
	const receiveEnd = workerSource.indexOf("export { app, receiveEmail }");
	const receiveSource = workerSource.slice(receiveStart, receiveEnd);
	const schemaIndex = receiveSource.indexOf("await ensureAppSchemaOnce(env.APP_DB)");
	const registryIndex = receiveSource.indexOf("await getMailboxRecord(env.APP_DB, mailboxId)");
	const mailboxDoIndex = receiveSource.indexOf("env.MAILBOX");

	expect(schemaIndex).toBeGreaterThanOrEqual(0);
	expect(registryIndex).toBeGreaterThan(schemaIndex);
	expect(mailboxDoIndex).toBeGreaterThan(registryIndex);
	expect(receiveSource).toContain("EMAIL_ADDRESSES");
	expect(receiveSource).toContain("mailbox is not active in APP_DB");
});
