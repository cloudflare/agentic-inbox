import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const header = readFileSync(new URL("./Header.tsx", import.meta.url), "utf8");
const queries = readFileSync(
	new URL("../queries/push.ts", import.meta.url),
	"utf8",
);

test("header identity comes from the shared actor query, not a bespoke fetch", () => {
	assert.match(header, /const \{ data: me, isError: identityUnavailable \} = useCurrentActor\(\)/);
	assert.doesNotMatch(header, /fetch\("\/api\/v1\/me"/);
	assert.match(queries, /export function useCurrentActor\(\)/);
	assert.match(queries, /queryKey: queryKeys\.currentActor/);
});

test("an unreachable identity retries on refocus and says so instead of vanishing", () => {
	assert.match(queries, /staleTime: 5 \* 60_000,\s*refetchOnWindowFocus: true,/);
	assert.match(
		header,
		/identityUnavailable\s*\?\s*"Sign out \(account details unavailable\)"/,
	);
});
