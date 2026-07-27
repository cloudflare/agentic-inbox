import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const appDir = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return entry.name.endsWith(".tsx") ? [full] : [];
	});
}

/**
 * Base UI renders DropdownMenu.Label as a group label, so it reads
 * MenuGroupRootContext and throws the whole route into its error boundary when
 * no DropdownMenu.Group encloses it. Source-pinned because that crash only
 * appears once a menu is actually opened.
 */
test("every DropdownMenu.Label is enclosed by a DropdownMenu.Group", () => {
	const offenders: string[] = [];
	let labelsChecked = 0;

	for (const file of sourceFiles(appDir)) {
		const lines = readFileSync(file, "utf8").split("\n");
		let depth = 0;
		lines.forEach((line, index) => {
			if (line.includes("<DropdownMenu.Group>")) depth += 1;
			if (line.includes("<DropdownMenu.Label")) {
				labelsChecked += 1;
				if (depth === 0) {
					offenders.push(`${path.relative(appDir, file)}:${index + 1}`);
				}
			}
			if (line.includes("</DropdownMenu.Group>")) depth -= 1;
		});
		assert.equal(depth, 0, `unbalanced DropdownMenu.Group in ${file}`);
	}

	assert.deepEqual(offenders, []);
	assert.ok(labelsChecked > 0, "the contract check must actually find labels");
});
