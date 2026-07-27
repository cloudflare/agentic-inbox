import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

test("a failed folder fetch is named and retryable, never an empty mailbox", () => {
	assert.match(sidebar, /isError: foldersError,\s*refetch: refetchFolders,/);
	assert.match(
		sidebar,
		/foldersError && \([\s\S]*?role="alert"[\s\S]*?Folders didn’t load[\s\S]*?onClick=\{\(\) => void refetchFolders\(\)\}[\s\S]*?Try again/,
	);
});

test("a failed label fetch is named and retryable, never an empty label list", () => {
	assert.match(sidebar, /isError: labelsError,\s*refetch: refetchLabels,/);
	assert.match(
		sidebar,
		/labelsError \? \([\s\S]*?role="alert"[\s\S]*?Labels didn’t load[\s\S]*?onClick=\{\(\) => void refetchLabels\(\)\}[\s\S]*?Try again/,
	);
	// The empty state still belongs to a mailbox that genuinely has no labels.
	assert.match(sidebar, /\) : labels\.length === 0 \? \([\s\S]*?Create your first label/);
});

test("reopening the create-folder dialog starts a clean attempt", () => {
	assert.match(
		sidebar,
		/const openCreateFolder = \(\) => \{\s*setNewFolderName\(""\);\s*setCreateFolderError\(""\);\s*setIsCreateFolderOpen\(true\);/,
	);
	// Every entry point clears, so a stale error can never greet the next create.
	assert.doesNotMatch(sidebar, /onClick=\{\(\) => setIsCreateFolderOpen\(true\)\}/);
	assert.equal(sidebar.match(/onClick=\{openCreateFolder\}/g)?.length, 2);
});
