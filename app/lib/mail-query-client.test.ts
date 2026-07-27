import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { onlineManager } from "@tanstack/react-query";
import { createMailQueryClient } from "./mail-query-client.ts";

test("offline mail actions fail immediately and are never replayed after reconnecting", async () => {
	const wasOnline = onlineManager.isOnline();
	onlineManager.setOnline(false);
	const queryClient = createMailQueryClient();
	queryClient.mount();
	let attempts = 0;
	let execution: Promise<unknown> | undefined;

	try {
		const mutation = queryClient.getMutationCache().build(queryClient, {
			mutationFn: async () => {
				attempts += 1;
				throw new Error("offline transport");
			},
		});

		execution = mutation.execute(undefined);
		await Promise.resolve();
		assert.equal(attempts, 1);
		assert.equal(mutation.state.isPaused, false);
		await assert.rejects(execution, {
			message: "offline transport",
		});

		onlineManager.setOnline(true);
		await Promise.resolve();
		assert.equal(attempts, 1);
	} finally {
		// Release a mutation if the policy regresses to TanStack's paused default,
		// then restore the shared online manager for the rest of the test process.
		onlineManager.setOnline(true);
		await execution?.catch(() => undefined);
		onlineManager.setOnline(wasOnline);
		queryClient.unmount();
		queryClient.clear();
	}
});

test("a failed conversation update names the action instead of reverting silently", () => {
	const queries = readFileSync(
		new URL("../queries/emails.ts", import.meta.url),
		"utf8",
	);
	const updateEmail = queries.slice(
		queries.indexOf("export function useUpdateEmail"),
		queries.indexOf("export function useMarkThreadRead"),
	);
	assert.match(
		updateEmail,
		/onError:[\s\S]*?toastManager\.add\(\{\s*title: updateEmailFailureTitle\(data\),\s*variant: "error",/,
	);
});
