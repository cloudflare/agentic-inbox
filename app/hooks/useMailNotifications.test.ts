import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const hook = read("./useMailNotifications.ts");
const mailboxRoute = read("../routes/mailbox.tsx");
const folders = read("../queries/folders.ts");

test("new-mail toasts ride the change feed instead of a second inbox poll", () => {
	assert.doesNotMatch(hook, /refetchInterval/);
	// Both are mounted on the same route, so the feed's invalidation of the
	// emails root is what refreshes the inbox this hook watches.
	assert.match(mailboxRoute, /useMailNotifications\(mailboxId\)/);
	assert.match(mailboxRoute, /useMailboxChangeFeed\(mailboxId\)/);
});

test("the unread tab title keeps its own refresh source", () => {
	assert.match(hook, /document\.title = unread > 0/);
	assert.match(folders, /refetchInterval: 30_000/);
});
