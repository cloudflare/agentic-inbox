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

const ITEM_TAG = /<DropdownMenu\.(?:Item|LinkItem|CheckboxItem|RadioItem)\b/g;

/** An opening tag ends at the first `>` outside any `{…}` expression. */
function openingTag(source: string, start: number): string {
	let depth = 0;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		if (character === "{") depth += 1;
		else if (character === "}") depth -= 1;
		else if (character === ">" && depth === 0) return source.slice(start, index + 1);
	}
	return source.slice(start);
}

/**
 * Base UI activates menu items through `onClick`; it has no `onSelect` prop.
 * React's DOM `onSelect` still type-checks on the underlying `<div>`, so an
 * item wired that way compiles, opens, and closes on tap while its handler
 * never runs. Source-pinned because only a real click exposes it.
 */
test("no DropdownMenu item is wired through onSelect", () => {
	const offenders: string[] = [];
	let itemsChecked = 0;

	for (const file of sourceFiles(appDir)) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(ITEM_TAG)) {
			itemsChecked += 1;
			if (!/\bonSelect\s*=/.test(openingTag(source, match.index))) continue;
			const line = source.slice(0, match.index).split("\n").length;
			offenders.push(`${path.relative(appDir, file)}:${line}`);
		}
	}

	assert.deepEqual(offenders, []);
	assert.ok(itemsChecked > 0, "the contract check must actually find items");
});
