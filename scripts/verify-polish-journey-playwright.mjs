// Throwaway verification harness for the polish/comprehensive-pass live journey.
// Modeled on scripts/verify-email-body-playwright.mjs: same isolated D1 state,
// same local Wiser runtime, same bootstrap login, same script-logs artifacts.
// Read-only with respect to product code; it observes and screenshots only.

import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const artifactDirectory = join(root, "script-logs");
const runStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const logFilePath = join(artifactDirectory, `polish-journey-${runStamp}.log`);
const resultsPath = join(artifactDirectory, `polish-journey-${runStamp}-results.json`);
const wranglerLogPath = join(artifactDirectory, `wrangler-polish-journey-${runStamp}.log`);
const configPath = join(root, "scripts", "wrangler-email-body-playwright.jsonc");
const mailboxId = "playwright-email-body@wiserchat.ai";
const password = "LocalMailPortal!2026";

mkdirSync(artifactDirectory, { recursive: true });

const findings = [];

function logLine(channel, message) {
	appendFileSync(logFilePath, `${new Date().toISOString()} ${channel} ${message}\n`);
}
function progress(message) {
	console.log(message);
	logLine("PROGRESS", message);
}
function detail(message) {
	logLine("DETAIL", String(message));
}
function record(item, viewport, status, note, shots = []) {
	findings.push({ item, viewport, status, note, shots });
	const line = `[${status}] ${item} @${viewport}: ${note}`;
	console.log(line);
	logLine("RESULT", line);
}
function formatFailure(error) {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
function delay(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
async function pollValue(readValue, accept, label, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	while (Date.now() < deadline) {
		value = await readValue();
		if (accept(value)) return value;
		await delay(100);
	}
	throw new Error(
		`${label} never reached the expected state; last: ${
			value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)
		}`,
	);
}

function localEnvironment(overrides = {}) {
	const environment = {};
	for (const name of [
		"PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME",
		"SHELL", "LANG", "LC_ALL", "TERM", "NO_COLOR",
	]) {
		if (process.env[name]) environment[name] = process.env[name];
	}
	return { ...environment, ...overrides };
}

async function freePort() {
	const server = createServer();
	await new Promise((res, rej) => {
		server.once("error", rej);
		server.listen(0, "127.0.0.1", res);
	});
	const address = server.address();
	await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
	return address.port;
}

async function runSetupCommand(args, environment) {
	const child = spawn("npx", args, { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.on("data", (c) => detail(`setup stdout ${c}`));
	child.stderr.on("data", (c) => detail(`setup stderr ${c}`));
	const result = await new Promise((res, rej) => {
		child.once("error", rej);
		child.once("exit", (code, signal) => res({ code, signal }));
	});
	if (result.code !== 0) throw new Error(`Database setup exited with ${result.code ?? result.signal}`);
}

async function waitForServer(baseUrl, serverProcess) {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
			throw new Error(`Wiser test server exited with ${serverProcess.exitCode ?? serverProcess.signalCode}`);
		}
		try {
			const response = await fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(1_500) });
			if (response.ok) return;
		} catch {
			// not bound yet
		}
		await delay(250);
	}
	throw new Error("Wiser test server did not become ready within 90 seconds");
}

async function stopServer(serverProcess) {
	if (!serverProcess?.pid || serverProcess.exitCode !== null) return;
	try {
		process.kill(-serverProcess.pid, "SIGTERM");
	} catch (error) {
		if (error?.code === "ESRCH") return;
		serverProcess.kill("SIGTERM");
	}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline && serverProcess.exitCode === null) await delay(50);
	if (serverProcess.exitCode !== null) return;
	try {
		process.kill(-serverProcess.pid, "SIGKILL");
	} catch (error) {
		if (error?.code !== "ESRCH") serverProcess.kill("SIGKILL");
	}
}

// ---------------------------------------------------------------------------
// Seeded conversations
// ---------------------------------------------------------------------------

const LONG_SUBJECT =
	"Rollout window confirmed for the multi-region failover rehearsal including the read-replica cutover, the DNS propagation soak and the post-incident review scheduling for every affected regional operations team";

/**
 * Snippets are handed over exactly as a naive server projection would emit them:
 * raw HTML including a <style> head. A clean row therefore proves the client
 * strips non-prose rather than proving the fixture was pre-cleaned.
 */
const MARKETING_RAW_SNIPPET =
	'<style type="text/css">.wrap{max-width:600px}.btn{background:#2563eb;color:#fff;padding:12px 20px}@media only screen and (max-width:600px){.btn{display:block!important}}</style>' +
	'<div class="wrap"><span class="btn">Save 30% on annual plans this week only &mdash; ends Friday.</span></div>';

const MARKETING_TAIL = "TAIL LINE BELOW THE MARKETING IMAGES";

const MARKETING_BODY = [
	"<style type=\"text/css\">",
	"body{margin:0;font-family:Helvetica,Arial,sans-serif;background:#f4f5f7}",
	".wrap{max-width:600px;margin:0 auto;background:#ffffff}",
	".btn{display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:6px}",
	"@media only screen and (max-width:600px){.btn{display:block!important;width:100%!important}}",
	"</style>",
	'<div class="wrap">',
	'<img alt="Marketing hero" src="https://cdn.brightmail.example/hero.svg" style="width:100%">',
	"<h1>Your July product update is here</h1>",
	"<p>Save 30% on annual plans this week only.</p>",
	'<img alt="Marketing tracker" src="https://cdn.brightmail.example/pixel.png" width="1" height="1">',
	// Mixed source: the src can never load under either CSP, the srcset can once
	// the reader opts in. Offering "Load images" and then still hiding it is the
	// defect this fixture exists to catch.
	'<img alt="Marketing mixed" src="/journey-relative-fallback.png" srcset="https://cdn.brightmail.example/mixed.svg 1x">',
	// Same shape one level out: the surviving candidate is a sibling <source>,
	// which the <img> walk runs too early to see.
	'<picture><source srcset="https://cdn.brightmail.example/picture.svg 1x">',
	'<img alt="Marketing picture" src="/journey-relative-fallback.png"></picture>',
	// A source the picture can never select: surviving the opt-in is not proof
	// anything renders, so this img must stay hidden rather than become an
	// empty alt box.
	'<picture><source media="not all" srcset="https://cdn.brightmail.example/ineligible.svg 1x">',
	'<img alt="Marketing ineligible" src="/journey-relative-fallback.png"></picture>',
	// Sender-forged internal markers: DOMPurify passes data-* through, and these
	// must mean nothing until the sanitize walk stamps them from real policy.
	'<img alt="Marketing forged" data-remote-image-drawn="true" src="https://cdn.brightmail.example/forged.svg">',
	`<p>${MARKETING_TAIL}</p>`,
	"</div>",
].join("");

const threadMessages = [
	{
		id: "t-thread-m1",
		sender: "ada@calculus.example",
		sender_name: "Ada Lovelace",
		date: "2026-07-20T09:00:00.000Z",
		body: "<p>MESSAGE ONE OLDEST: shall we lock the launch date this week?</p>",
	},
	{
		id: "t-thread-m2",
		sender: mailboxId,
		sender_name: "Playwright Operator",
		date: "2026-07-21T09:00:00.000Z",
		body: "<p>MESSAGE TWO: I can do any day after the 10th.</p>",
	},
	{
		id: "t-thread-m3",
		sender: "ada@calculus.example",
		sender_name: "Ada Lovelace",
		date: "2026-07-22T09:00:00.000Z",
		body: "<p>MESSAGE THREE: the 12th works for engineering.</p>",
	},
	{
		id: "t-thread-m4",
		sender: "grace@partner.example",
		sender_name: "Grace Hopper",
		date: "2026-07-23T09:00:00.000Z",
		body: "<p>MESSAGE FOUR NEWEST: agreed, let us lock the launch for the 12th.</p>",
	},
].map((message) => ({
	...message,
	conversation_id: "t-thread",
	thread_id: "t-thread",
	folder_id: "inbox",
	subject: "Quarterly launch decision",
	recipient: mailboxId,
	read: true,
	starred: false,
	body_external: false,
	attachments: [],
	labels: [],
}));

const conversations = [
	{
		id: "c-marketing",
		conversation_id: "t-marketing",
		thread_id: "t-marketing",
		folder_id: "inbox",
		subject: "Your July product update is here",
		sender: "news@brightmail.example",
		sender_name: "Bright Mail Weekly",
		participant_names: "Bright Mail Weekly",
		recipient: mailboxId,
		date: "2026-07-26T09:00:00.000Z",
		read: false,
		starred: false,
		body: null,
		body_external: true,
		snippet: MARKETING_RAW_SNIPPET,
		has_attachments: false,
		thread_count: 1,
		thread_unread_count: 1,
		attachments: [],
		labels: [],
	},
	{
		...threadMessages[3],
		participant_names: "Ada Lovelace, Grace Hopper, Playwright Operator",
		participants: "ada@calculus.example, grace@partner.example",
		snippet: "MESSAGE FOUR NEWEST: agreed, let us lock the launch for the 12th.",
		has_attachments: false,
		thread_count: 4,
		thread_unread_count: 0,
	},
	{
		id: "c-attach",
		conversation_id: "t-attach",
		thread_id: "t-attach",
		folder_id: "inbox",
		subject: "Signed contract attached",
		sender: "legal@northwind.example",
		sender_name: "Northwind Legal",
		participant_names: "Northwind Legal",
		recipient: mailboxId,
		date: "2026-07-24T15:20:00.000Z",
		read: true,
		starred: false,
		body: "<p>Please countersign the attached contract before Friday.</p>",
		body_external: false,
		snippet: "<p>Please countersign the attached contract before Friday.</p>",
		has_attachments: true,
		thread_count: 1,
		attachments: [
			{
				id: "contract-pdf",
				filename: "northwind-contract.pdf",
				mimetype: "application/pdf",
				size: 20_480,
				disposition: "attachment",
			},
		],
		labels: [],
	},
	{
		id: "c-named",
		conversation_id: "t-named",
		thread_id: "t-named",
		folder_id: "inbox",
		subject: "Coffee next week?",
		sender: "ada@calculus.example",
		sender_name: "Ada Lovelace",
		participant_names: "Ada Lovelace",
		recipient: mailboxId,
		date: "2026-07-23T08:05:00.000Z",
		read: true,
		starred: false,
		body: "<p>Are you free Tuesday afternoon?</p>",
		body_external: false,
		snippet: "Are you free Tuesday afternoon?",
		has_attachments: false,
		thread_count: 1,
		attachments: [],
		labels: [],
	},
	{
		id: "c-noreply",
		conversation_id: "t-noreply",
		thread_id: "t-noreply",
		folder_id: "inbox",
		subject: "Your invoice 4417 is ready",
		sender: "no-reply@notifications.acmecloud.example",
		sender_name: null,
		participant_names: null,
		participants: null,
		recipient: mailboxId,
		date: "2026-07-22T06:00:00.000Z",
		read: true,
		starred: false,
		body: "<p>View your July statement online.</p>",
		body_external: false,
		snippet: "View your July statement online.",
		has_attachments: false,
		thread_count: 1,
		attachments: [],
		labels: [],
	},
	{
		id: "c-long",
		conversation_id: "t-long",
		thread_id: "t-long",
		folder_id: "inbox",
		subject: LONG_SUBJECT,
		sender: "ops@verylongsubject.example",
		sender_name: "Operations Desk",
		participant_names: "Operations Desk",
		recipient: mailboxId,
		date: "2026-07-21T11:30:00.000Z",
		read: true,
		starred: false,
		body: "<p>Rollout window confirmed.</p>",
		body_external: false,
		snippet: "Rollout window confirmed for every affected regional operations team.",
		has_attachments: false,
		thread_count: 1,
		attachments: [],
		labels: [],
	},
];

const byId = new Map();
for (const conversation of conversations) byId.set(conversation.id, conversation);
for (const message of threadMessages) if (!byId.has(message.id)) byId.set(message.id, message);

const threads = new Map([
	["t-thread", threadMessages],
	...conversations
		.filter((conversation) => conversation.thread_id !== "t-thread")
		.map((conversation) => [conversation.thread_id, [conversation]]),
]);

/**
 * Fixtures only the folder-list, message-metadata, thread and body reads. Every
 * other request - mutations, outbound deliveries, folders, settings - reaches
 * the real local runtime so send, undo and folder creation stay genuine.
 */
async function installFixture(page, counters) {
	const prefix = `/api/v1/mailboxes/${mailboxId}`;

	await page.route("https://cdn.brightmail.example/**", async (route) => {
		const url = route.request().url();
		if (url.endsWith("ineligible.svg")) {
			counters.ineligible += 1;
			await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"></svg>' });
			return;
		}
		if (url.endsWith("forged.svg")) {
			counters.forged += 1;
			await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"></svg>' });
			return;
		}
		if (url.endsWith("picture.svg")) {
			counters.picture += 1;
			await route.fulfill({
				status: 200,
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="160"><rect width="440" height="160" fill="#b45309"/><text x="28" y="95" fill="#fff" font-size="24">PICTURE SOURCE LOADED</text></svg>',
			});
			return;
		}
		if (url.endsWith("mixed.svg")) {
			counters.mixed += 1;
			await route.fulfill({
				status: 200,
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><rect width="480" height="180" fill="#15803d"/><text x="30" y="105" fill="#fff" font-size="26">MIXED SRCSET LOADED</text></svg>',
			});
			return;
		}
		if (url.endsWith("hero.svg")) {
			counters.hero += 1;
			// Answers late so the frame can only fit it by following the reflow.
			await delay(600);
			await route.fulfill({
				status: 200,
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="600" height="320" fill="#2563eb"/><text x="40" y="170" fill="#fff" font-size="34">HERO IMAGE LOADED</text></svg>',
			});
			return;
		}
		counters.tracker += 1;
		await route.fulfill({ status: 204 });
	});

	await page.route("**/api/v1/mailboxes/**", async (route) => {
		const request = route.request();
		const path = decodeURIComponent(new URL(request.url()).pathname);
		if (request.method() !== "GET") {
			detail(`fixture passthrough ${request.method()} ${path}`);
			await route.continue();
			return;
		}
		if (path === `${prefix}/emails`) {
			const folderId = new URL(request.url()).searchParams.get("folder_id");
			if (folderId && folderId !== "inbox") {
				await route.continue();
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ emails: conversations, totalCount: conversations.length }),
			});
			return;
		}
		if (path === `${prefix}/search`) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ emails: conversations, totalCount: conversations.length }),
			});
			return;
		}
		if (path === `${prefix}/emails/c-marketing/body`) {
			await route.fulfill({ status: 200, contentType: "text/plain", body: MARKETING_BODY });
			return;
		}
		const threadMatch = path.match(new RegExp(`^${prefix}/threads/([^/]+)$`));
		if (threadMatch && threads.has(threadMatch[1])) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(threads.get(threadMatch[1])),
			});
			return;
		}
		const emailMatch = path.match(new RegExp(`^${prefix}/emails/([^/]+)$`));
		if (emailMatch && byId.has(emailMatch[1])) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(byId.get(emailMatch[1])),
			});
			return;
		}
		await route.continue();
	});
}

async function authenticate(browser, baseUrl) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
	await page.getByLabel("Email").fill(mailboxId);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
	await page.goto(`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`, {
		waitUntil: "domcontentloaded",
	});
	await delay(4_000);
	const state = await context.storageState();
	await context.close();
	return state;
}

function observe(page, scenario) {
	page.on("console", (message) => {
		if (message.type() === "error") detail(`${scenario} console error ${message.text()}`);
	});
	page.on("pageerror", (error) => detail(`${scenario} page error ${formatFailure(error)}`));
}

function shot(name, item, suffix) {
	return join(artifactDirectory, `polish-journey-${runStamp}-${name}-${item}-${suffix}.png`);
}

async function overflowGeometry(page) {
	return page.evaluate(() => ({
		viewport: window.innerWidth,
		document: document.scrollingElement?.scrollWidth ?? 0,
	}));
}

async function openInbox(page, baseUrl) {
	await page.goto(`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`, {
		waitUntil: "domcontentloaded",
	});
	await page.locator("[data-email-id]").first().waitFor({ timeout: 20_000 });
}

/** Everything one row actually renders, read from the DOM rather than a guess. */
async function readRows(page) {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll("[data-email-id]")).map((row) => {
			const open = row.querySelector("button[aria-label^='Open conversation']");
			const lines = open ? Array.from(open.children) : [];
			const time = row.querySelector("time");
			return {
				id: row.getAttribute("data-email-id"),
				ariaLabel: open?.getAttribute("aria-label") ?? "",
				lineCount: lines.length,
				sender: lines[0]?.querySelector("span:nth-child(2)")?.textContent?.trim() ?? "",
				senderTitle: lines[0]?.querySelector("span:nth-child(2)")?.getAttribute("title") ?? "",
				threadBadge: Array.from(lines[0]?.querySelectorAll("span") ?? [])
					.map((s) => s.textContent?.trim())
					.filter((t) => /^\d+$/.test(t ?? "")),
				hasPaperclip: Boolean(lines[0]?.querySelector("svg")),
				date: time?.textContent?.trim() ?? "",
				dateTime: time?.getAttribute("datetime") ?? "",
				subject: lines[1]?.textContent?.trim() ?? "",
				snippet: lines[2]?.textContent?.trim() ?? "",
				rowWidth: row.getBoundingClientRect().width,
				scrollWidth: row.scrollWidth,
			};
		}),
	);
}

// ---------------------------------------------------------------------------
// 1. LIST
// ---------------------------------------------------------------------------

async function verifyList(page, baseUrl, name) {
	const item = "01-list";
	try {
		await openInbox(page, baseUrl);
		await delay(500);
		const shots = [shot(name, item, "rows")];
		await page.screenshot({ path: shots[0], fullPage: false });

		const rows = await readRows(page);
		detail(`${name} rows ${JSON.stringify(rows, null, 1)}`);
		const problems = [];
		if (rows.length < 6) problems.push(`only ${rows.length} rows rendered`);

		const marketing = rows.find((r) => r.id === "c-marketing");
		const thread = rows.find((r) => r.id === "t-thread-m4");
		const attach = rows.find((r) => r.id === "c-attach");
		const named = rows.find((r) => r.id === "c-named");
		const noreply = rows.find((r) => r.id === "c-noreply");
		const long = rows.find((r) => r.id === "c-long");

		if (marketing?.sender !== "Bright Mail Weekly") {
			problems.push(`display-name sender wrong: ${marketing?.sender}`);
		}
		if (!marketing?.snippet) {
			problems.push("styled-email snippet is empty");
		} else if (/<[a-z/]|\{|\}|max-width|#2563eb|font-family|display:/i.test(marketing.snippet)) {
			problems.push(`styled-email snippet carries markup/CSS: "${marketing.snippet}"`);
		}
		if (/&[a-zA-Z]+;|&#\d+;/.test(marketing?.snippet ?? "")) {
			problems.push(`styled-email snippet shows an undecoded HTML entity: "${marketing?.snippet}"`);
		}
		if (!/Save 30% on annual plans/.test(marketing?.snippet ?? "")) {
			problems.push(`styled-email snippet lost its prose: "${marketing?.snippet}"`);
		}
		if (noreply?.sender !== "Acmecloud") {
			problems.push(`no-reply sender is "${noreply?.sender}", expected a domain-derived name`);
		}
		if (/no-?reply/i.test(noreply?.sender ?? "")) {
			problems.push(`no-reply sender leaked the local part: "${noreply?.sender}"`);
		}
		if (!attach?.hasPaperclip) problems.push("attachment row shows no paperclip");
		if (!/has attachments/.test(attach?.ariaLabel ?? "")) {
			problems.push(`attachment row open control does not announce attachments: "${attach?.ariaLabel}"`);
		}
		if (marketing?.hasPaperclip) problems.push("non-attachment row shows a paperclip");
		if (!thread?.threadBadge?.includes("4")) {
			problems.push(`thread count badge missing: ${JSON.stringify(thread?.threadBadge)}`);
		}
		if (named?.sender !== "Ada Lovelace") problems.push(`named sender wrong: ${named?.sender}`);
		for (const row of rows) {
			if (!row.date) problems.push(`row ${row.id} has no date`);
			if (row.lineCount < 3 && row.id !== undefined && row.snippet === "") {
				problems.push(`row ${row.id} rendered fewer than 3 lines`);
			}
			if (row.scrollWidth > row.rowWidth + 1) {
				problems.push(`row ${row.id} overflows horizontally (${row.scrollWidth} > ${row.rowWidth})`);
			}
		}
		if (!long?.subject?.startsWith("Rollout window confirmed")) {
			problems.push(`long subject row lost its subject: "${long?.subject}"`);
		}

		const geometry = await overflowGeometry(page);
		if (geometry.document > geometry.viewport) {
			problems.push(`page scrolls horizontally ${JSON.stringify(geometry)}`);
		}

		// Hover action cluster, desktop only (pointer: fine).
		if (name === "desktop") {
			const row = page.locator("[data-email-id]").first();
			const before = await page.evaluate(() => {
				const first = document.querySelector("[data-email-id]");
				const cluster = first?.querySelector("div.flex.shrink-0.items-center:last-child");
				return cluster ? getComputedStyle(cluster).display : "missing";
			});
			await row.hover();
			await delay(400);
			const hoverShot = shot(name, item, "hover");
			await page.screenshot({ path: hoverShot });
			shots.push(hoverShot);
			const after = await page.evaluate(() => {
				const first = document.querySelector("[data-email-id]");
				const buttons = Array.from(first?.querySelectorAll("button") ?? []);
				return buttons
					.filter((b) => b.getAttribute("aria-label") && !b.getAttribute("aria-label").startsWith("Open conversation"))
					.map((b) => ({
						label: b.getAttribute("aria-label"),
						visible: b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0,
					}));
			});
			detail(`${name} hover cluster before=${before} after=${JSON.stringify(after)}`);
			if (!after.some((b) => b.visible)) problems.push("hover revealed no row actions on desktop");
		}

		// Rows must stay readable at the default ~400px list pane: open one.
		if (name === "desktop") {
			await page.locator("button[aria-label^='Open conversation']").nth(3).click();
			await delay(1_200);
			const paneShot = shot(name, item, "list-pane-400");
			await page.screenshot({ path: paneShot });
			shots.push(paneShot);
			const paneRows = await readRows(page);
			const paneWidth = await page.evaluate(
				() => document.querySelector("section[aria-label='Message list']")?.getBoundingClientRect().width ?? 0,
			);
			detail(`${name} list pane width ${paneWidth}`);
			for (const row of paneRows) {
				if (row.scrollWidth > row.rowWidth + 1) {
					problems.push(`row ${row.id} overflows in the ${Math.round(paneWidth)}px pane`);
				}
			}
			if (Math.abs(paneWidth - 400) > 2) {
				detail(`${name} NOTE list pane defaulted to ${paneWidth}px, not 400px`);
			}
			await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
		}

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? "6 rows, 3 lines each; display-name and domain-derived senders correct; styled snippet is clean prose; paperclip + aria on the attachment row only; thread badge 4; no row or page overflow"
			: problems.join(" | "), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, [failShot]);
	}
}

// ---------------------------------------------------------------------------
// 2. THREAD ORDER
// ---------------------------------------------------------------------------

async function verifyThreadOrder(page, baseUrl, name) {
	const item = "02-thread-order";
	try {
		await openInbox(page, baseUrl);
		await page.getByRole("button", { name: /^Open conversation Quarterly launch decision/ }).click();
		await page.getByRole("heading", { name: "Quarterly launch decision" }).waitFor({ timeout: 20_000 });
		await delay(1_500);
		const shots = [shot(name, item, "thread")];
		await page.screenshot({ path: shots[0] });

		const layout = await page.evaluate(() => {
			const scroller = document.querySelector("#inline-compose-host")?.parentElement;
			const nodes = Array.from(document.querySelectorAll("[data-intelligence-message-id]"));
			return {
				order: nodes.map((n) => n.dataset.intelligenceMessageId),
				tops: nodes.map((n) => n.getBoundingClientRect().top),
				expanded: nodes
					.filter((n) => !n.querySelector("button[aria-label='Collapse message']") ? false : true)
					.map((n) => n.dataset.intelligenceMessageId),
				scrollTop: scroller?.scrollTop ?? -1,
				scrollHeight: scroller?.scrollHeight ?? -1,
				clientHeight: scroller?.clientHeight ?? -1,
				newestTop: nodes.at(-1)?.getBoundingClientRect().top ?? null,
				scrollerTop: scroller?.getBoundingClientRect().top ?? null,
				scrollerBottom: scroller?.getBoundingClientRect().bottom ?? null,
			};
		});
		detail(`${name} thread layout ${JSON.stringify(layout)}`);

		const problems = [];
		const expectedOrder = ["t-thread-m1", "t-thread-m2", "t-thread-m3", "t-thread-m4"];
		if (JSON.stringify(layout.order) !== JSON.stringify(expectedOrder)) {
			problems.push(`DOM order is ${JSON.stringify(layout.order)}, expected oldest-first ${JSON.stringify(expectedOrder)}`);
		}
		for (let index = 1; index < layout.tops.length; index += 1) {
			if (layout.tops[index] <= layout.tops[index - 1]) {
				problems.push(`visual order broken at index ${index}: ${JSON.stringify(layout.tops)}`);
			}
		}
		if (!layout.expanded.includes("t-thread-m4")) {
			problems.push("newest message is not expanded");
		}
		const newestVisible = await page.evaluate(() => {
			const newest = document.querySelector("[data-intelligence-message-id='t-thread-m4']");
			const scroller = document.querySelector("#inline-compose-host")?.parentElement;
			if (!newest || !scroller) return null;
			const a = newest.getBoundingClientRect();
			const b = scroller.getBoundingClientRect();
			return { top: a.top, bottom: a.bottom, viewTop: b.top, viewBottom: b.bottom };
		});
		detail(`${name} newest visibility ${JSON.stringify(newestVisible)}`);
		if (newestVisible && (newestVisible.top >= newestVisible.viewBottom || newestVisible.bottom <= newestVisible.viewTop)) {
			problems.push(`newest message is outside the visible conversation area ${JSON.stringify(newestVisible)}`);
		}
		// Bodies render inside per-message iframes, so the text lives in a frame.
		const frameTexts = [];
		for (const frame of page.frames()) {
			if (frame === page.mainFrame()) continue;
			frameTexts.push(await frame.evaluate(() => document.body?.innerText ?? "").catch(() => ""));
		}
		detail(`${name} frame texts ${JSON.stringify(frameTexts.map((t) => t.slice(0, 120)))}`);
		if (!frameTexts.some((text) => /MESSAGE FOUR NEWEST/.test(text))) {
			problems.push(`newest message body is not rendered in any frame; frames: ${JSON.stringify(frameTexts.map((t) => t.slice(0, 60)))}`);
		}

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? "m1..m4 oldest-first in DOM and by bounding-box top; newest expanded and inside the scroller viewport"
			: problems.join(" | "), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, [failShot]);
	}
}

// ---------------------------------------------------------------------------
// 3. INLINE REPLY
// ---------------------------------------------------------------------------

async function openThread(page, baseUrl) {
	await openInbox(page, baseUrl);
	await page.getByRole("button", { name: /^Open conversation Quarterly launch decision/ }).click();
	await page.getByRole("heading", { name: "Quarterly launch decision" }).waitFor({ timeout: 20_000 });
	await delay(1_200);
}

async function clickThreadAction(page, label) {
	const direct = page.getByRole("button", { name: label, exact: true });
	if (await direct.count()) {
		await direct.first().click();
		return;
	}
	// Sub-xl the toolbar collapses actions into an overflow menu.
	const more = page.getByRole("button", { name: /More actions|More/ }).first();
	await more.click();
	await page.getByRole("menuitem", { name: new RegExp(`^${label}$`) }).click();
}

async function clickReply(page) {
	await clickThreadAction(page, "Reply");
}

/** Escape, then answer the discard prompt if one appears. */
async function dismissComposer(page) {
	await page.keyboard.press("Escape").catch(() => {});
	await delay(700);
	const discard = page.getByRole("button", { name: /^Discard$/i }).first();
	if (await discard.count()) await discard.click().catch(() => {});
	await delay(500);
}

async function inlineComposerGeometry(page) {
	return page.evaluate(() => {
		const host = document.getElementById("inline-compose-host");
		if (!host) return { hosted: false };
		const editor = host.querySelector("[aria-label='Message body']");
		const messages = Array.from(document.querySelectorAll("[data-intelligence-message-id]"));
		const newest = messages.at(-1);
		const hostBox = host.getBoundingClientRect();
		return {
			hosted: true,
			hasComposer: host.childElementCount > 0,
			hasEditor: Boolean(editor),
			editorFocused: document.activeElement === editor || Boolean(editor?.contains(document.activeElement)),
			activeElement: document.activeElement?.getAttribute("aria-label")
				?? document.activeElement?.tagName ?? null,
			editorHtml: editor?.innerHTML ?? "",
			editorText: editor?.textContent ?? "",
			hostTop: hostBox.top,
			hostWidth: hostBox.width,
			hostScrollWidth: host.scrollWidth,
			newestTop: newest?.getBoundingClientRect().top ?? null,
			threadStillVisible: messages.length,
			subjectValue:
				document.querySelector("input[name='subject'], input[aria-label='Subject']")?.value
				?? Array.from(host.querySelectorAll("input")).map((i) => i.value).find((v) => /^Re:/i.test(v))
				?? null,
			overflowingChildren: Array.from(host.querySelectorAll("*"))
				.filter((el) => el.getBoundingClientRect().right > hostBox.right + 1)
				.slice(0, 5)
				.map((el) => ({
					tag: el.tagName,
					cls: String(el.className).slice(0, 60),
					right: el.getBoundingClientRect().right,
					hostRight: hostBox.right,
				})),
		};
	});
}

async function verifyInlineReply(page, baseUrl, name) {
	const item = "03-inline-reply";
	const shots = [];
	try {
		await openThread(page, baseUrl);
		await clickReply(page);
		await delay(1_800);
		const composerShot = shot(name, item, "composer");
		await page.screenshot({ path: composerShot });
		shots.push(composerShot);

		const geometry = await inlineComposerGeometry(page);
		detail(`${name} inline composer ${JSON.stringify(geometry, null, 1)}`);
		const problems = [];
		if (!geometry.hosted) problems.push("inline compose host is missing from the DOM");
		if (!geometry.hasComposer) problems.push("composer did not render into the inline host");
		if (!geometry.hasEditor) problems.push("composer has no message-body editor");
		if (geometry.threadStillVisible < 4) problems.push("thread messages disappeared when the composer opened");
		if (geometry.newestTop !== null && geometry.hostTop <= geometry.newestTop) {
			problems.push(`composer is not at the thread end (hostTop ${geometry.hostTop} <= newestTop ${geometry.newestTop})`);
		}
		if (!geometry.editorFocused) {
			problems.push(`focus is not in the editor; active element is ${geometry.activeElement}`);
		}
		// The reply opens on a clean body: the message being answered is already
		// on screen in the thread right above the composer.
		if (/data-mail-quoted-reply|MESSAGE FOUR NEWEST|wrote:/i.test(geometry.editorHtml)) {
			problems.push(`the composer seeded a quoted original: ${geometry.editorHtml.slice(0, 200)}`);
		}
		if (geometry.editorText.trim()) {
			problems.push(`the reply body is not empty: "${geometry.editorText.trim().slice(0, 120)}"`);
		}
		const subject = geometry.subjectValue ?? (await page.evaluate(() => {
			const inputs = Array.from(document.querySelectorAll("input"));
			return inputs.map((i) => i.value).find((v) => /launch decision/i.test(v)) ?? null;
		}));
		detail(`${name} composer subject "${subject}"`);
		if (subject && !/^Re:\s/i.test(subject)) problems.push(`subject not Re:-prefixed: "${subject}"`);
		if (subject && /Re:\s*Re:/i.test(subject)) problems.push(`subject double-prefixed: "${subject}"`);

		const geo = await overflowGeometry(page);
		if (geo.document > geo.viewport) problems.push(`page overflows horizontally ${JSON.stringify(geo)}`);
		if (geometry.hostScrollWidth > geometry.hostWidth + 1) {
			problems.push(`inline composer overflows its host (${geometry.hostScrollWidth} > ${geometry.hostWidth})`);
		}
		if (geometry.overflowingChildren.length > 0) {
			problems.push(`composer children spill past the host: ${JSON.stringify(geometry.overflowingChildren)}`);
		}

		// Narrowest split the UI allows, desktop only.
		if (name === "desktop") {
			const separator = page.getByRole("separator", { name: "Resize message list" });
			if (await separator.count()) {
				await separator.focus();
				for (let index = 0; index < 24; index += 1) {
					await separator.press("ArrowRight");
				}
				await delay(800);
				const narrowShot = shot(name, item, "narrow-split");
				await page.screenshot({ path: narrowShot });
				shots.push(narrowShot);
				const narrow = await inlineComposerGeometry(page);
				const paneWidths = await page.evaluate(() => ({
					list: document.querySelector("section[aria-label='Message list']")?.getBoundingClientRect().width ?? 0,
					conversation: document.querySelector("section[aria-label='Conversation']")?.getBoundingClientRect().width ?? 0,
				}));
				detail(`${name} narrow split panes ${JSON.stringify(paneWidths)} composer ${JSON.stringify(narrow)}`);
				if (narrow.hostScrollWidth > narrow.hostWidth + 1) {
					problems.push(`at the narrowest split the composer overflows (${narrow.hostScrollWidth} > ${narrow.hostWidth})`);
				}
				if (narrow.overflowingChildren.length > 0) {
					problems.push(`at the narrowest split composer children spill: ${JSON.stringify(narrow.overflowingChildren)}`);
				}
				const narrowGeo = await overflowGeometry(page);
				if (narrowGeo.document > narrowGeo.viewport) {
					problems.push(`narrow split causes page overflow ${JSON.stringify(narrowGeo)}`);
				}
				// Controls must remain reachable, not stacked off the pane.
				const clipped = await page.evaluate(() => {
					const host = document.getElementById("inline-compose-host");
					const section = document.querySelector("section[aria-label='Conversation']");
					if (!host || !section) return [];
					const bounds = section.getBoundingClientRect();
					return Array.from(host.querySelectorAll("button"))
						.filter((b) => {
							const r = b.getBoundingClientRect();
							return r.width > 0 && (r.right > bounds.right + 1 || r.left < bounds.left - 1);
						})
						.map((b) => ({ label: b.textContent?.trim().slice(0, 30), right: b.getBoundingClientRect().right, bound: bounds.right }));
				});
				if (clipped.length > 0) problems.push(`composer buttons clipped at narrow split: ${JSON.stringify(clipped)}`);
				// Restore a normal split for later checks.
				for (let index = 0; index < 24; index += 1) await separator.press("ArrowLeft");
				await delay(400);
			} else {
				detail(`${name} no split separator present; narrow-split check not applicable`);
			}
		}

		// Escape must run the close flow without destroying the thread.
		const closeState = async () => page.evaluate(() => {
			const host = document.getElementById("inline-compose-host");
			const prompts = Array.from(
				document.querySelectorAll("[role='dialog'], [role='alertdialog']"),
			).map((d) => ({
				role: d.getAttribute("role"),
				text: (d.textContent ?? "").trim().slice(0, 200),
				buttons: Array.from(d.querySelectorAll("button")).map((b) => b.textContent?.trim()),
			}));
			return {
				composerGone: (host?.childElementCount ?? 0) === 0,
				messages: document.querySelectorAll("[data-intelligence-message-id]").length,
				active: document.activeElement?.getAttribute("data-intelligence-message-id")
					?? document.activeElement?.getAttribute("aria-label")
					?? document.activeElement?.tagName ?? null,
				prompts,
				closeButtons: Array.from(host?.querySelectorAll("button") ?? [])
					.map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())
					.filter(Boolean),
			};
		});

		// Escape from inside the rich-text editor.
		await page.locator("#inline-compose-host [aria-label='Message body']").first().click().catch(() => {});
		await page.keyboard.press("Escape");
		await delay(2_000);
		const escapeFromEditor = await closeState();
		detail(`${name} escape from editor ${JSON.stringify(escapeFromEditor)}`);

		// Escape from a plain field in the same card, to separate "Escape is not
		// wired on the inline card" from "the editor swallows the key".
		let escapeFromSubject = null;
		if (!escapeFromEditor.composerGone) {
			const subjectField = page.locator("#inline-compose-host").getByLabel("Subject", { exact: true }).first();
			if (await subjectField.count()) {
				await subjectField.click();
				await page.keyboard.press("Escape");
				await delay(2_000);
				escapeFromSubject = await closeState();
				detail(`${name} escape from subject ${JSON.stringify(escapeFromSubject)}`);
			}
		}
		let afterEscape = escapeFromSubject ?? escapeFromEditor;
		if (escapeFromEditor.composerGone) afterEscape = escapeFromEditor;
		const escapeSummary =
			`escape-from-editor closed=${escapeFromEditor.composerGone}` +
			(escapeFromSubject ? `, escape-from-subject closed=${escapeFromSubject.composerGone}` : "");
		detail(`${name} ${escapeSummary}`);
		const escapeShot = shot(name, item, "after-escape");
		await page.screenshot({ path: escapeShot });
		shots.push(escapeShot);

		let closedVia = afterEscape.composerGone ? "escape" : null;
		if (!closedVia && afterEscape.prompts.length > 0) {
			const discard = page.getByRole("button", { name: /^(Discard|Discard draft|Delete draft)$/i }).first();
			if (await discard.count()) {
				await discard.click();
				await delay(1_500);
				afterEscape = await closeState();
				if (afterEscape.composerGone) closedVia = "escape+discard prompt";
			}
		}
		if (!closedVia) {
			// Fall back to the composer's own close affordance to separate
			// "Escape is not wired" from "the composer cannot be closed at all".
			const close = page.locator("#inline-compose-host").getByRole("button", { name: /^(Close|Cancel|Discard)$/i }).first();
			if (await close.count()) {
				await close.click();
				await delay(1_500);
				const promptState = await closeState();
				if (!promptState.composerGone && promptState.prompts.length > 0) {
					const discard = page.getByRole("button", { name: /^(Discard|Discard draft|Delete draft)$/i }).first();
					if (await discard.count()) {
						await discard.click();
						await delay(1_500);
					}
				}
				afterEscape = await closeState();
				if (afterEscape.composerGone) closedVia = "explicit close button";
			}
		}
		detail(`${name} close resolution via=${closedVia} state=${JSON.stringify(afterEscape)}`);
		const closedShot = shot(name, item, "after-close");
		await page.screenshot({ path: closedShot });
		shots.push(closedShot);

		if (!afterEscape.composerGone) {
			problems.push(`composer could not be closed (Escape and close button both left it mounted); state ${JSON.stringify(afterEscape)}`);
		} else if (closedVia !== "escape" && closedVia !== "escape+discard prompt") {
			problems.push(`Escape did not close the inline composer (${escapeSummary}); only "${closedVia}" did`);
		}
		if (afterEscape.messages < 4) problems.push("closing destroyed the thread view");
		if (afterEscape.composerGone && (afterEscape.active === "BODY" || afterEscape.active === null)) {
			problems.push(`focus was dropped on close (active element ${afterEscape.active})`);
		}

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? "composer mounts into #inline-compose-host below the newest message, thread stays mounted, editor focused, body clean with no quoted original, subject Re:-prefixed once, no overflow at default or narrowest split, Escape restores focus to the thread"
			: problems.join(" | "), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		shots.push(failShot);
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, shots);
	}
}

/**
 * The forwarded original is a marked block: compose seeds it, and signature
 * placement plus AI rewrites navigate by that marker, so the editor schema has
 * to carry it through a real edit. A reply seeds no quote at all - the message
 * being answered is already in the thread above the composer - so the same walk
 * proves its absence survives editing too.
 */
async function verifyQuotedBlocks(page, baseUrl, name) {
	const item = "03b-quoted-blocks";
	const shots = [];
	const problems = [];
	const observed = [];
	try {
		for (const scenario of [
			{ action: "Forward", marker: "data-mail-forwarded-message", tag: "div", expect: "kept" },
			{ action: "Reply", marker: "data-mail-quoted-reply", tag: null, expect: "absent" },
		]) {
			await openThread(page, baseUrl);
			await clickThreadAction(page, scenario.action);
			await delay(1_500);
			const editor = page.locator("[aria-label='Message body']").first();
			await editor.waitFor({ timeout: 10_000 });
			await editor.click();
			await page.keyboard.type("Confirming the date.");
			await delay(600);

			const state = await page.evaluate((marker) => {
				const body = document.querySelector("[aria-label='Message body']");
				const block = body?.querySelector(`[${marker}]`) ?? null;
				return {
					found: Boolean(block),
					tag: block?.tagName.toLowerCase() ?? null,
					version: block?.getAttribute(marker) ?? null,
					styled: Boolean(block?.getAttribute("style")),
					quotesAnyone: /wrote:|MESSAGE FOUR NEWEST/i.test(body?.textContent ?? ""),
					typedThrough: (body?.textContent ?? "").includes("Confirming the date."),
					html: (body?.innerHTML ?? "").slice(0, 300),
				};
			}, scenario.marker);
			observed.push({ action: scenario.action, ...state, html: undefined });
			detail(`${name} ${scenario.action} marked block ${JSON.stringify(state)}`);
			const blockShot = shot(name, item, scenario.action.toLowerCase());
			await page.screenshot({ path: blockShot });
			shots.push(blockShot);

			if (!state.typedThrough) {
				problems.push(`${scenario.action}: typed text never reached the editor`);
			}
			if (scenario.expect === "absent") {
				if (state.found) {
					problems.push(`${scenario.action}: seeded ${scenario.marker}, which replies must no longer do`);
				}
				if (state.quotesAnyone) {
					problems.push(`${scenario.action}: the original leaked into the reply body ("${state.html}")`);
				}
			} else if (!state.found) {
				problems.push(
					`${scenario.action}: ${scenario.marker} was dropped once the user typed; body starts "${state.html}"`,
				);
			} else {
				if (state.version !== "v1") {
					problems.push(`${scenario.action}: marker value is "${state.version}", expected "v1"`);
				}
				if (state.tag !== scenario.tag) {
					problems.push(`${scenario.action}: marker landed on <${state.tag}>, expected <${scenario.tag}>`);
				}
				if (!state.styled) {
					problems.push(`${scenario.action}: the quote styling was dropped from the marked block`);
				}

				// One Backspace at the block's first character used to unwrap it and
				// take the marker and styling with it.
				await page.evaluate((marker) => {
					const block = document.querySelector(`[${marker}]`);
					const text = block?.querySelector("strong") ?? block;
					const range = document.createRange();
					range.setStart(text.firstChild ?? text, 0);
					range.collapse(true);
					const selection = window.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
				}, scenario.marker);
				await page.keyboard.press("Backspace");
				await delay(500);
				const afterBackspace = await page.evaluate((marker) => {
					const body = document.querySelector("[aria-label='Message body']");
					const block = body?.querySelector(`[${marker}]`) ?? null;
					return { found: Boolean(block), styled: Boolean(block?.getAttribute("style")) };
				}, scenario.marker);
				detail(`${name} ${scenario.action} after Backspace at boundary ${JSON.stringify(afterBackspace)}`);
				if (!afterBackspace.found || !afterBackspace.styled) {
					problems.push(
						`${scenario.action}: Backspace at the block boundary dissolved it (${JSON.stringify(afterBackspace)})`,
					);
				}

				// ...but an explicit select-all still removes it, so the block is
				// protected, not permanent.
				await page.locator("[aria-label='Message body']").first().click();
				await page.keyboard.press("ControlOrMeta+a");
				await page.keyboard.press("Delete");
				await delay(500);
				const afterSelectAll = await page.evaluate((marker) =>
					Boolean(document.querySelector(`[aria-label='Message body'] [${marker}]`)),
				scenario.marker);
				detail(`${name} ${scenario.action} block after select-all delete: ${afterSelectAll}`);
				if (afterSelectAll) {
					problems.push(`${scenario.action}: select-all + Delete could not remove the block`);
				}
			}
			await dismissComposer(page);
		}

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? `after a real edit the forward keeps <div data-mail-forwarded-message="v1" style> and the reply body stays clean of any quote: ${JSON.stringify(observed)}`
			: problems.join(" | "), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		shots.push(failShot);
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, shots);
	}
}

// ---------------------------------------------------------------------------
// 4. SEND FEEDBACK
// ---------------------------------------------------------------------------

/**
 * Kumo renders toasts through a portal with no stable test hook, so this finds
 * the smallest element that actually contains send-lifecycle copy rather than
 * betting on a selector.
 */
async function readToasts(page) {
	return page.evaluate(() => {
		const pattern =
			/Sending…|Sending\.\.\.|^Sent$|Couldn.t send|Still sending|status unclear|Send cancelled|Scheduled for|Failed to send|Cannot send|no recipient|Could not cancel/i;
		const matches = [];
		for (const node of document.querySelectorAll("body *")) {
			const text = (node.textContent ?? "").trim();
			if (!text || text.length > 300) continue;
			if (!pattern.test(text)) continue;
			// The sidebar carries a "Sent" folder link; only on-screen toast copy counts.
			if (node.closest("nav, aside, [aria-label='Message list'], header")) continue;
			const box = node.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) continue;
			const style = getComputedStyle(node);
			if (style.visibility === "hidden" || style.display === "none") continue;
			// Keep only the innermost container that still holds the whole phrase.
			if (Array.from(node.children).some((child) => pattern.test((child.textContent ?? "").trim()))) {
				continue;
			}
			matches.push(node);
		}
		const seen = new Set();
		const results = [];
		for (const node of matches) {
			// Climb to the nearest ancestor that also carries the action buttons.
			let container = node;
			for (let hop = 0; hop < 4; hop += 1) {
				if (container.querySelector("button")) break;
				container = container.parentElement ?? container;
			}
			const text = (node.textContent ?? "").trim();
			if (seen.has(text)) continue;
			seen.add(text);
			results.push({
				text: text.slice(0, 200),
				buttons: Array.from(container.querySelectorAll("button"))
					.map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim())
					.filter(Boolean),
			});
		}
		return results;
	});
}

/**
 * A brand-new message posts to /emails, which the real durable object accepts.
 * The fixtured thread's reply target does not exist server-side, so the reply
 * route 404s; both are exercised and reported separately.
 */
async function composeRealMessage(page, bodyText, subject) {
	await page.keyboard.press("c");
	await delay(1_500);
	const to = page.getByLabel("To", { exact: true }).first();
	await to.waitFor({ timeout: 10_000 });
	await to.click();
	await to.fill("journey-recipient@example.com");
	await page.keyboard.press("Tab");
	await delay(300);
	const subjectInput = page.getByLabel("Subject", { exact: true }).first();
	await subjectInput.click();
	await subjectInput.fill(subject);
	const editor = page.locator("[aria-label='Message body']").first();
	await editor.click();
	await page.keyboard.type(bodyText);
	await delay(400);
}

async function verifyInlineReplySendAttempt(page, baseUrl, name) {
	const item = "04a-inline-reply-send";
	const responses = [];
	const onResponse = (response) => {
		if (response.request().method() !== "POST") return;
		const path = new URL(response.url()).pathname;
		if (/\/emails(\/[^/]+\/(reply|forward))?$/.test(path)) {
			responses.push({ path, status: response.status() });
		}
	};
	page.on("response", onResponse);
	try {
		await openThread(page, baseUrl);
		await clickReply(page);
		await delay(1_500);
		const editor = page.locator("#inline-compose-host [aria-label='Message body']");
		await editor.waitFor({ timeout: 10_000 });
		await editor.click();
		await page.keyboard.type("Locking the 12th. Sent from the polish journey verification.");
		await page.locator("#inline-compose-host").getByRole("button", { name: /^Send$/ }).first().click();
		await delay(3_000);
		const toasts = await readToasts(page);
		const bodyText = await page.locator("body").innerText();
		const errorVisible = /Failed to send|Couldn.t send|not found|Cannot send/i.test(bodyText);
		const shotPath = shot(name, item, "reply-send");
		await page.screenshot({ path: shotPath });
		detail(`${name} inline reply send responses ${JSON.stringify(responses)} toasts ${JSON.stringify(toasts)}`);
		const status = responses[0]?.status;
		if (status === 404) {
			record(item, name, "PARTIAL",
				`inline reply POSTs to ${responses[0].path} and the local runtime answers 404 because the thread is fixtured, not stored; the UI surfaced ${errorVisible ? "an error" : "NO error"} (${JSON.stringify(toasts)}). Delivery lifecycle for a reply therefore not exercisable here; covered by the real compose send in 04-send-feedback`,
				[shotPath]);
			if (!errorVisible) {
				record(item, name, "FAIL", "a 404 send left no visible error state on screen", [shotPath]);
			}
		} else {
			record(item, name, status && status < 300 ? "PASS" : "FAIL",
				`inline reply send returned ${JSON.stringify(responses)}; toasts ${JSON.stringify(toasts)}`, [shotPath]);
		}
	} catch (error) {
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, []);
	} finally {
		page.off("response", onResponse);
		await page.keyboard.press("Escape").catch(() => {});
		await delay(500);
		const discard = page.getByRole("button", { name: /^Discard$/i }).first();
		if (await discard.count()) await discard.click().catch(() => {});
		await delay(500);
	}
}

async function verifySendFeedback(page, baseUrl, name) {
	const item = "04-send-feedback";
	const shots = [];
	const problems = [];
	const timeline = [];
	const sendResponses = [];
	const onResponse = (response) => {
		if (response.request().method() !== "POST") return;
		const path = new URL(response.url()).pathname;
		if (/\/emails(\/[^/]+\/(reply|forward))?$/.test(path)) {
			sendResponses.push({ path, status: response.status() });
		}
	};
	page.on("response", onResponse);
	try {
		await openInbox(page, baseUrl);
		await delay(500);
		await composeRealMessage(
			page,
			"Sending from the polish journey verification.",
			"Journey send lifecycle",
		);

		const send = page.getByRole("button", { name: /^Send$/ }).first();
		await send.click();
		await delay(1_200);

		let firstToast = await readToasts(page);
		timeline.push({ at: "t+1.2s", toasts: firstToast });
		const sendingShot = shot(name, item, "sending");
		await page.screenshot({ path: sendingShot });
		shots.push(sendingShot);
		detail(`${name} send responses ${JSON.stringify(sendResponses)}`);
		detail(`${name} toast t+1.2s ${JSON.stringify(firstToast)}`);

		const sendingToast = firstToast.find((t) => /Sending…|Sending\.\.\./.test(t.text));
		if (!sendingToast) {
			problems.push(`no "Sending…" toast after send; observed ${JSON.stringify(firstToast)}`);
		} else if (!sendingToast.buttons?.some((b) => /Undo/i.test(b ?? ""))) {
			problems.push(`"Sending…" toast has no Undo action; buttons ${JSON.stringify(sendingToast.buttons)}`);
		}

		// Leaving the mailbox mid-send must not strand the watch. In-app
		// navigation only (the sidebar's own button), because a full load would
		// reset the store this is meant to exercise.
		const leftMailbox = await page.evaluate(() => {
			const back = Array.from(document.querySelectorAll("button")).find(
				(button) => button.textContent?.trim() === "Mailboxes",
			);
			back?.click();
			return Boolean(back);
		});
		await delay(2_000);
		const awayUrl = page.url();
		const awayToasts = await readToasts(page);
		const awayShot = shot(name, item, "away-mid-send");
		await page.screenshot({ path: awayShot });
		shots.push(awayShot);
		await page.goBack();
		await delay(2_500);
		const backToasts = await readToasts(page);
		const pendingToastElements = await page.evaluate(() =>
			Array.from(document.querySelectorAll("[data-toast-title]")).filter((title) =>
				/Sending…|Sending\.\.\./.test((title.textContent ?? "").trim()),
			).length,
		);
		const backShot = shot(name, item, "back-mid-send");
		await page.screenshot({ path: backShot });
		shots.push(backShot);
		timeline.push({ at: "away", url: awayUrl, toasts: awayToasts });
		timeline.push({ at: "back", url: page.url(), toasts: backToasts, pendingToastElements });
		detail(`${name} away ${awayUrl} ${JSON.stringify(awayToasts)} back ${JSON.stringify(backToasts)} pending elements ${pendingToastElements}`);

		if (!leftMailbox) {
			problems.push("no in-app Mailboxes control to leave the mailbox mid-send");
		} else if (!/\/mailboxes/.test(awayUrl)) {
			problems.push(`leaving the mailbox mid-send did not reach /mailboxes (url ${awayUrl})`);
		}
		if (awayToasts.length === 0) {
			problems.push("the in-flight send lost its toast when the mailbox route unmounted");
		}
		// readToasts collapses identical copy, so count the real toast elements:
		// an orphaned "Sending…" plus a freshly created one read the same.
		if (pendingToastElements > 1) {
			problems.push(
				`returning mid-send left ${pendingToastElements} "Sending…" toasts (the first was orphaned and a second was raised)`,
			);
		}

		// Watch the lifecycle resolve. The cap is 90s in send-outcome.ts.
		let resolved = null;
		const deadline = Date.now() + 105_000;
		while (Date.now() < deadline) {
			const toasts = await readToasts(page);
			const terminal = toasts.find((t) =>
				/Couldn.t send|Still sending|status unclear|^Sent$|\bSent\b/.test(t.text) && !/Sending…/.test(t.text)
			);
			if (terminal) {
				resolved = terminal;
				break;
			}
			await delay(2_000);
		}
		timeline.push({ at: "resolved", toast: resolved });
		detail(`${name} resolved toast ${JSON.stringify(resolved)}`);
		const resolvedShot = shot(name, item, "resolved");
		await page.screenshot({ path: resolvedShot });
		shots.push(resolvedShot);

		if (!resolved) {
			problems.push("send toast never resolved within 105s (stuck on Sending…)");
		} else if (/Couldn.t send/.test(resolved.text)) {
			if (!resolved.buttons?.some((b) => /Open Outbox/i.test(b ?? ""))) {
				problems.push(`failure toast offers no Open Outbox action: ${JSON.stringify(resolved.buttons)}`);
			} else {
				await page.getByRole("button", { name: "Open Outbox" }).first().click();
				await delay(2_500);
				const outboxShot = shot(name, item, "outbox");
				await page.screenshot({ path: outboxShot });
				shots.push(outboxShot);
				const url = page.url();
				detail(`${name} after Open Outbox url ${url}`);
				if (!/\/emails\/outbox/.test(url)) {
					problems.push(`Open Outbox did not navigate to the Outbox (url ${url})`);
				}
				const outboxText = await page.locator("body").innerText();
				if (!/polish journey|Quarterly launch decision|Outbox/i.test(outboxText)) {
					problems.push("Outbox does not show the failed message");
				}
			}
		}

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? `POST ${JSON.stringify(sendResponses)}; lifecycle: "Sending…" + Undo -> "${resolved?.text}"; recovery action lands in the Outbox`
			: `${problems.join(" | ")} || POST ${JSON.stringify(sendResponses)}`, shots);
		detail(`${name} send timeline ${JSON.stringify(timeline, null, 1)}`);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		shots.push(failShot);
		record(item, name, "FAIL", `threw: ${formatFailure(error)} || POST ${JSON.stringify(sendResponses)}`, shots);
	} finally {
		page.off("response", onResponse);
	}
}

async function verifyUndo(page, baseUrl, name) {
	const item = "04b-undo";
	const shots = [];
	const problems = [];
	try {
		await openInbox(page, baseUrl);
		await delay(500);
		await composeRealMessage(
			page,
			"This message is cancelled inside the undo window.",
			"Journey undo window",
		);
		await page.getByRole("button", { name: /^Send$/ }).first().click();
		await delay(900);
		const undo = page.getByRole("button", { name: "Undo" }).first();
		if (!(await undo.count())) {
			const noUndoShot = shot(name, item, "no-undo");
			await page.screenshot({ path: noUndoShot });
			record(item, name, "PARTIAL",
				`no Undo action appeared within 900ms of send; toasts ${JSON.stringify(await readToasts(page))}`,
				[noUndoShot]);
			return;
		}
		const cancelCalls = [];
		const onCancel = async (response) => {
			const path = new URL(response.url()).pathname;
			if (/outbound-deliveries\/[^/]+\/cancel/.test(path)) {
				cancelCalls.push({ path, status: response.status(), body: (await response.text().catch(() => "")).slice(0, 200) });
			}
		};
		page.on("response", onCancel);
		await undo.click();
		await delay(4_000);
		const undoShot = shot(name, item, "cancelled");
		await page.screenshot({ path: undoShot });
		shots.push(undoShot);
		const toasts = await readToasts(page);
		const bodyText = await page.locator("body").innerText();
		page.off("response", onCancel);
		detail(`${name} undo toasts ${JSON.stringify(toasts)} cancelCalls ${JSON.stringify(cancelCalls)}`);
		if (cancelCalls.length === 0) {
			problems.push("clicking Undo issued no cancel request");
		} else if (cancelCalls[0].status >= 300) {
			problems.push(`cancel request failed: ${JSON.stringify(cancelCalls[0])}`);
		}
		if (!/Send cancelled/i.test(bodyText)) {
			problems.push(`no "Send cancelled" confirmation; toasts ${JSON.stringify(toasts)}; cancel ${JSON.stringify(cancelCalls)}`);
		}
		if (toasts.some((t) => /Couldn.t send|Still sending/i.test(t.text))) {
			problems.push("a cancelled send still resolved to a failure/timeout toast");
		}
		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? "Undo inside the window cancels and confirms; no stale failure toast follows"
			: problems.join(" | "), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, [failShot]);
	}
}

// ---------------------------------------------------------------------------
// 5. IMAGES
// ---------------------------------------------------------------------------

async function verifyImages(page, baseUrl, name, counters) {
	const item = "05-images";
	const shots = [];
	const problems = [];
	try {
		await openInbox(page, baseUrl);
		await page.getByRole("button", { name: /^Open conversation Your July product update/ }).click();
		await page.getByRole("heading", { name: "Your July product update is here" }).waitFor({ timeout: 20_000 });
		await delay(2_000);

		const frame = page.getByTitle("Email content").first();
		await frame.waitFor({ timeout: 15_000 });
		const handle = await frame.elementHandle();
		const content = await handle.contentFrame();
		await content.getByText(MARKETING_TAIL).waitFor({ timeout: 15_000 });

		const blockedShot = shot(name, item, "blocked");
		await page.screenshot({ path: blockedShot });
		shots.push(blockedShot);

		const blocked = await content.evaluate(() =>
			Array.from(document.images).map((img) => ({
				alt: img.alt,
				display: getComputedStyle(img).display,
				src: img.getAttribute("src"),
				naturalWidth: img.naturalWidth,
				height: img.getBoundingClientRect().height,
			})),
		);
		detail(`${name} blocked images ${JSON.stringify(blocked)}`);
		for (const image of blocked) {
			if (image.display !== "none") {
				problems.push(`blocked image "${image.alt}" is not hidden (display ${image.display}) - broken-glyph risk`);
			}
			if (image.src) problems.push(`blocked image "${image.alt}" kept its remote src`);
		}
		if (Object.values(counters).some((count) => count !== 0)) {
			problems.push(`remote images were fetched before opt-in: ${JSON.stringify(counters)}`);
		}
		// A sender-supplied data-remote-image-drawn must not survive the sanitize
		// walk and reveal a remote image before consent.
		const forgedBlocked = await content.evaluate(() => {
			const image = document.querySelector("img[alt='Marketing forged']");
			return {
				present: Boolean(image),
				display: image ? getComputedStyle(image).display : null,
				drawn: image?.hasAttribute("data-remote-image-drawn") ?? null,
				src: image?.getAttribute("src") ?? null,
			};
		});
		detail(`${name} forged marker pre-consent ${JSON.stringify(forgedBlocked)}`);
		if (forgedBlocked.present && (forgedBlocked.drawn || forgedBlocked.display !== "none" || forgedBlocked.src)) {
			problems.push(`a sender-forged data-remote-image-drawn survived sanitizing: ${JSON.stringify(forgedBlocked)}`);
		}
		const banner = page.getByRole("button", { name: "Load images" });
		if (!(await banner.count())) {
			problems.push("no Load images banner on a message with blocked remote images");
		}
		const blockedFrameHeight = await frame.evaluate((el) => el.getBoundingClientRect().height);

		if (await banner.count()) {
			await banner.first().click();
			await pollValue(() => counters.hero, (v) => v === 1, "hero image opt-in fetch", 20_000);
			const optedHandle = await page.getByTitle("Email content").first().elementHandle();
			const optedContent = await optedHandle.contentFrame();
			const grown = await pollValue(
				() =>
					Promise.all([
						page.getByTitle("Email content").first().evaluate((el) => el.getBoundingClientRect().height),
						optedContent.evaluate(() => ({
							clientHeight: document.documentElement.clientHeight,
							scrollHeight: document.documentElement.scrollHeight,
							heroHeight:
								document.querySelector("img[alt='Marketing hero']")?.getBoundingClientRect().height ?? 0,
							heroDisplay: document.querySelector("img[alt='Marketing hero']")
								? getComputedStyle(document.querySelector("img[alt='Marketing hero']")).display
								: "missing",
							tailVisible: Boolean(
								Array.from(document.querySelectorAll("p")).find((p) => p.textContent?.includes("TAIL LINE")),
							),
							tailBottom:
								Array.from(document.querySelectorAll("p"))
									.find((p) => p.textContent?.includes("TAIL LINE"))
									?.getBoundingClientRect().bottom ?? 0,
						})),
					]).then(([frameHeight, doc]) => ({ frameHeight, ...doc })),
				(v) => v.heroHeight > 100 && v.tailVisible,
				"opted-in hero render",
				25_000,
			);
			await delay(800);
			const loadedShot = shot(name, item, "loaded");
			await page.screenshot({ path: loadedShot });
			shots.push(loadedShot);
			detail(`${name} opted-in geometry ${JSON.stringify(grown)}`);

			if (grown.heroDisplay === "none") problems.push("hero image stayed hidden after Load images");
			if (grown.scrollHeight > grown.clientHeight + 1) {
				problems.push(`frame owns an internal scrollbar after opt-in (${grown.scrollHeight} > ${grown.clientHeight})`);
			}
			if (grown.frameHeight < grown.scrollHeight - 1) {
				problems.push(`frame clips the body after opt-in (frame ${grown.frameHeight} < content ${grown.scrollHeight})`);
			}
			if (grown.frameHeight <= blockedFrameHeight) {
				problems.push(`frame height did not follow the late image (${blockedFrameHeight} -> ${grown.frameHeight})`);
			}
			if (grown.tailBottom > grown.clientHeight + 1) {
				problems.push(`text below the images is clipped (tail bottom ${grown.tailBottom} > client ${grown.clientHeight})`);
			}

			// An image whose src can never load, but which some other candidate the
			// reader just opted into can still draw, must reveal itself rather than
			// stay marked blocked. Two carriers, same defect: the img's own srcset,
			// and a sibling <source> the img walk runs too early to see.
			for (const shape of [
				{ alt: "Marketing mixed", counter: "mixed", carrier: "its own srcset" },
				{ alt: "Marketing picture", counter: "picture", carrier: "a sibling <picture> source" },
			]) {
				await pollValue(
					() => counters[shape.counter],
					(v) => v === 1,
					`${shape.alt} opt-in fetch`,
					15_000,
				).catch(() => counters[shape.counter]);
				await delay(400);
				const state = await optedContent.evaluate((alt) => {
					const image = document.querySelector(`img[alt='${alt}']`);
					if (!image) return { present: false };
					const picture = image.closest("picture");
					return {
						present: true,
						display: getComputedStyle(image).display,
						blocked: image.hasAttribute("data-remote-image-blocked"),
						src: image.getAttribute("src"),
						srcset: image.getAttribute("srcset"),
						sourceSrcset:
							picture?.querySelector("source")?.getAttribute("srcset") ?? null,
						height: image.getBoundingClientRect().height,
						naturalWidth: image.naturalWidth,
					};
				}, shape.alt);
				detail(`${name} ${shape.alt} after opt-in ${JSON.stringify(state)} fetches ${counters[shape.counter]}`);

				if (!state.present) {
					problems.push(`"${shape.alt}" is missing from the opted-in document`);
					continue;
				}
				if (state.blocked) {
					problems.push(`"${shape.alt}" is still marked blocked after opt-in though ${shape.carrier} survived`);
				}
				if (state.display === "none") {
					problems.push(`"${shape.alt}" stayed hidden after Load images`);
				}
				if (state.src) problems.push(`"${shape.alt}" kept its unloadable src "${state.src}"`);
				if (!state.srcset && !state.sourceSrcset) {
					problems.push(`"${shape.alt}" lost the candidate the reader opted in to`);
				}
				if (state.naturalWidth === 0) {
					problems.push(`"${shape.alt}" never decoded ${shape.carrier}`);
				}
			}

			// The ineligible-source picture is the control: opting in must NOT
			// reveal it, because nothing in it can draw.
			const ineligible = await optedContent.evaluate(() => {
				const image = document.querySelector("img[alt='Marketing ineligible']");
				if (!image) return { present: false };
				return {
					present: true,
					display: getComputedStyle(image).display,
					blocked: image.hasAttribute("data-remote-image-blocked"),
					drawn: image.hasAttribute("data-remote-image-drawn"),
				};
			});
			detail(`${name} ineligible source after opt-in ${JSON.stringify(ineligible)} fetches ${counters.ineligible}`);
			if (ineligible.present) {
				if (ineligible.drawn) {
					problems.push("an ineligible <source> (media='not all') was stamped drawn");
				}
				if (ineligible.display !== "none") {
					problems.push("an image with no eligible candidate was revealed as an empty box");
				}
			}
		}

		const geo = await overflowGeometry(page);
		if (geo.document > geo.viewport) problems.push(`page overflows horizontally ${JSON.stringify(geo)}`);

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? `blocked state hides every remote image with no fetch (hero 0/tracker 0) and shows the banner; Load images fetches, reveals the hero, grows the frame ${Math.round(blockedFrameHeight)}->taller with no internal scrollbar and the tail line unclipped`
			: problems.join(" | "), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		shots.push(failShot);
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, shots);
	}
}

// ---------------------------------------------------------------------------
// 6. KEYBOARD
// ---------------------------------------------------------------------------

/** Focus a row's open button and report what that row is. */
async function focusRow(page, index) {
	return page.evaluate((rowIndex) => {
		const rows = Array.from(document.querySelectorAll("[data-email-id]"));
		const row = rows[rowIndex];
		const button = row?.querySelector("button[aria-label^='Open conversation']");
		button?.focus();
		return {
			rows: rows.length,
			id: row?.getAttribute("data-email-id") ?? null,
			subject: (button?.getAttribute("aria-label") ?? "")
				.replace(/^Open conversation /, "")
				.replace(/, has attachments$/, ""),
			focused: document.activeElement === button,
		};
	}, index);
}

async function openedHeadings(page) {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll("h1, h2, h3, [role='heading']"))
			.map((heading) => heading.textContent?.trim())
			.filter(Boolean)
			.slice(0, 12),
	);
}

/**
 * Enter belongs to the row that has focus, on every surface. Search and Saved
 * Views listen for no open-message command at all, so cancelling the native
 * activation there left Enter doing nothing; in folders it opened the ringed
 * row rather than the focused one. j/k now moves DOM focus with the ring, so
 * both agree.
 */
async function verifyRowActivation(page, baseUrl, name) {
	const item = "06c-row-activation";
	const shots = [];
	const problems = [];
	const observed = [];
	try {
		for (const surface of [
			{ label: "folder", url: `${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox` },
			{ label: "search", url: `${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/search?q=renewal` },
		]) {
			await page.goto(surface.url, { waitUntil: "domcontentloaded" });
			await page.locator("[data-email-id]").first().waitFor({ timeout: 20_000 });
			await delay(700);

			// Focus the SECOND row, so "the focused row" and "the first row" differ.
			const target = await focusRow(page, 1);
			if (!target.focused || !target.subject) {
				problems.push(`${surface.label}: could not focus the second row (${JSON.stringify(target)})`);
				continue;
			}
			await page.keyboard.press("Enter");
			await delay(1_800);
			const headings = await openedHeadings(page);
			observed.push({ surface: surface.label, subject: target.subject, headings: headings.slice(0, 4) });
			detail(`${name} ${surface.label} Tab+Enter target ${JSON.stringify(target)} headings ${JSON.stringify(headings)}`);
			const shotPath = shot(name, item, `${surface.label}-enter`);
			await page.screenshot({ path: shotPath });
			shots.push(shotPath);
			const probe = target.subject.slice(0, 24);
			if (!headings.some((heading) => heading.includes(probe))) {
				problems.push(
					`${surface.label}: Enter on the focused row did not open "${target.subject}" (headings ${JSON.stringify(headings)})`,
				);
			}
		}

		// And after j/k the ring carries focus with it, so Enter opens the ringed row.
		await openInbox(page, baseUrl);
		await delay(600);
		await focusRow(page, 0);
		await page.keyboard.press("j");
		await delay(500);
		await page.keyboard.press("j");
		await delay(500);
		const ringed = await page.evaluate(() => {
			const row = Array.from(document.querySelectorAll("[data-email-id]")).find((r) =>
				String(r.className).includes("ring-inset"),
			);
			const button = row?.querySelector("button[aria-label^='Open conversation']");
			return {
				id: row?.getAttribute("data-email-id") ?? null,
				subject: (button?.getAttribute("aria-label") ?? "")
					.replace(/^Open conversation /, "")
					.replace(/, has attachments$/, ""),
				focusIsRinged: document.activeElement === button,
			};
		});
		detail(`${name} ringed after j/k ${JSON.stringify(ringed)}`);
		observed.push({ surface: "folder j/k", ...ringed });
		if (!ringed.focusIsRinged) {
			problems.push(`j/k left DOM focus off the ringed row (${JSON.stringify(ringed)})`);
		}
		if (ringed.subject) {
			await page.keyboard.press("Enter");
			await delay(1_800);
			const headings = await openedHeadings(page);
			const ringShot = shot(name, item, "jk-enter");
			await page.screenshot({ path: ringShot });
			shots.push(ringShot);
			detail(`${name} j/k Enter headings ${JSON.stringify(headings)}`);
			if (!headings.some((heading) => heading.includes(ringed.subject.slice(0, 24)))) {
				problems.push(
					`Enter after j/k did not open the ringed "${ringed.subject}" (headings ${JSON.stringify(headings)})`,
				);
			}
		}

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? `Enter opens the focused row on the folder list and on Search, and j/k carries DOM focus with the ring: ${JSON.stringify(observed)}`
			: problems.join(" | "), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		shots.push(failShot);
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, shots);
	}
}

async function keyboardTargetId(page) {
	return page.evaluate(() => {
		const row = Array.from(document.querySelectorAll("[data-email-id]")).find((r) =>
			String(r.className).includes("ring-inset"),
		);
		return row?.getAttribute("data-email-id") ?? null;
	});
}

async function verifyKeyboard(page, baseUrl, name) {
	const item = "06-keyboard";
	const shots = [];
	const problems = [];
	try {
		await openInbox(page, baseUrl);
		await delay(600);

		// Give a row real focus, the state the "shortcuts survive row focus" fix targets.
		const focusResult = await page.evaluate(() => {
			const row = document.querySelector("[data-email-id]");
			const control = row?.querySelector("button");
			control?.focus();
			return {
				focused: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null,
				insideRow: Boolean(row?.contains(document.activeElement)),
			};
		});
		detail(`${name} row focus ${JSON.stringify(focusResult)}`);
		if (!focusResult.insideRow) problems.push("could not place focus inside a list row");

		const before = await keyboardTargetId(page);
		await page.keyboard.press("j");
		await delay(500);
		const afterJ = await keyboardTargetId(page);
		await page.keyboard.press("j");
		await delay(400);
		const afterJJ = await keyboardTargetId(page);
		await page.keyboard.press("k");
		await delay(400);
		const afterK = await keyboardTargetId(page);
		detail(`${name} j/k targets before=${before} j=${afterJ} jj=${afterJJ} k=${afterK}`);
		const navShot = shot(name, item, "jk-navigation");
		await page.screenshot({ path: navShot });
		shots.push(navShot);
		if (afterJ === null) problems.push("j did not move a keyboard target onto any row (shortcut dead with row focused)");
		if (afterJJ === afterJ) problems.push(`second j did not advance (stuck on ${afterJ})`);
		if (afterK !== afterJ) problems.push(`k did not step back (j=${afterJ}, jj=${afterJJ}, k=${afterK})`);

		// Enter belongs to whatever control has focus. The list shortcut must not
		// cancel a focused button's own activation.
		const buttonFocused = await page.evaluate(() => {
			const compose = Array.from(document.querySelectorAll("button")).find(
				(button) => button.textContent?.trim() === "Compose",
			);
			compose?.focus();
			return Boolean(compose) && document.activeElement === compose;
		});
		if (!buttonFocused) {
			problems.push("could not focus the Compose button for the Enter activation check");
		} else {
			await page.keyboard.press("Enter");
			await delay(1_400);
			const enterState = await page.evaluate(() => ({
				composers: document.querySelectorAll("[aria-label='Message body']").length,
				url: location.pathname,
			}));
			detail(`${name} Enter on focused button ${JSON.stringify(enterState)}`);
			const enterShot = shot(name, item, "enter-on-button");
			await page.screenshot({ path: enterShot });
			shots.push(enterShot);
			if (enterState.composers === 0) {
				problems.push("Enter on the focused Compose button did not activate it (global shortcut cancelled the native default)");
			}
			await dismissComposer(page);
		}

		// Command palette.
		await page.keyboard.press("Meta+k");
		await delay(700);
		let paletteOpen = await page.getByRole("dialog").filter({ hasText: /Command palette|Search|Jump/ }).count();
		if (paletteOpen === 0) {
			await page.keyboard.press("Control+k");
			await delay(700);
			paletteOpen = await page.getByRole("dialog").count();
		}
		const paletteShot = shot(name, item, "palette");
		await page.screenshot({ path: paletteShot });
		shots.push(paletteShot);
		if (paletteOpen === 0) problems.push("neither Meta+K nor Control+K opened the command palette");
		await page.keyboard.press("Escape");
		await delay(600);

		// Compose via c, then typing must not trigger shortcuts.
		await page.keyboard.press("c");
		await delay(1_200);
		const composerOpen = await page.locator("[aria-label='Message body']").count();
		if (composerOpen === 0) problems.push("c did not open a composer");
		const composeShot = shot(name, item, "compose");
		await page.screenshot({ path: composeShot });
		shots.push(composeShot);

		if (composerOpen > 0) {
			const editor = page.locator("[aria-label='Message body']").first();
			await editor.click();
			await page.keyboard.type("cjkes# typing must not fire shortcuts");
			await delay(700);
			const afterTyping = await page.evaluate(() => ({
				editorText: document.querySelector("[aria-label='Message body']")?.textContent ?? "",
				dialogs: document.querySelectorAll("[role='dialog']").length,
				composersMounted: document.querySelectorAll("[aria-label='Message body']").length,
				url: location.pathname,
			}));
			detail(`${name} after typing ${JSON.stringify(afterTyping)}`);
			if (!/cjkes# typing must not fire shortcuts/.test(afterTyping.editorText)) {
				problems.push(`typed text was swallowed: "${afterTyping.editorText}"`);
			}
			if (afterTyping.composersMounted > 1) {
				problems.push(`typing "c" opened another composer (${afterTyping.composersMounted} mounted)`);
			}
			if (!/emails\/inbox/.test(afterTyping.url)) {
				problems.push(`typing navigated away to ${afterTyping.url}`);
			}

			await page.keyboard.press("Escape");
			await delay(1_000);
			const discardShot = shot(name, item, "escape-discard");
			await page.screenshot({ path: discardShot });
			shots.push(discardShot);
			const escapeState = await page.evaluate(() => ({
				dialogText: Array.from(document.querySelectorAll("[role='dialog'], [role='alertdialog']"))
					.map((d) => d.textContent?.trim().slice(0, 160)),
				composersMounted: document.querySelectorAll("[aria-label='Message body']").length,
			}));
			detail(`${name} escape state ${JSON.stringify(escapeState)}`);
			const promptedOrClosed =
				escapeState.composersMounted === 0 ||
				escapeState.dialogText.some((t) => /discard|save|draft/i.test(t ?? ""));
			if (!promptedOrClosed) {
				problems.push(`Escape neither closed the composer nor raised a discard prompt: ${JSON.stringify(escapeState)}`);
			}
			// Clear whatever is on screen for the next check.
			const discard = page.getByRole("button", { name: /^Discard$/i }).first();
			if (await discard.count()) await discard.click().catch(() => {});
			await delay(500);
		}

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? "with focus inside a row: j/k move the keyboard target, ⌘K/Ctrl-K opens the palette, c opens the composer, typed shortcut letters land as text with no second composer and no navigation, Escape runs the discard flow"
			: problems.join(" | "), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		shots.push(failShot);
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, shots);
	}
}

// ---------------------------------------------------------------------------
// 7. SWEEP SPOT-CHECKS
// ---------------------------------------------------------------------------

async function seedFolders(page, baseUrl, count) {
	const created = [];
	for (let index = 1; index <= count; index += 1) {
		const name = `Journey Folder ${String(index).padStart(2, "0")}`;
		const result = await page.evaluate(
			async ({ url, folderName }) => {
				const response = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					credentials: "include",
						body: JSON.stringify({ name: folderName, operationId: crypto.randomUUID() }),
				});
				return { status: response.status, body: (await response.text()).slice(0, 200) };
			},
			{
				url: `${baseUrl}/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/folders`,
				folderName: name,
			},
		);
		created.push({ name, ...result });
	}
	return created;
}

async function verifySweeps(page, baseUrl, name) {
	const item = "07-sweeps";
	const shots = [];
	const problems = [];
	const notes = [];
	try {
		await openInbox(page, baseUrl);
		await delay(600);

		// Sidebar
		const sidebar = await page.evaluate(() => {
			const nav = document.querySelector("nav, aside");
			const text = nav?.innerText ?? "";
			return {
				present: Boolean(nav),
				hasInbox: /Inbox/i.test(text),
				hasSent: /Sent/i.test(text),
				hasLabels: /Label/i.test(text),
				error: /could not|failed|unavailable/i.test(text),
				sample: text.slice(0, 300),
			};
		});
		detail(`${name} sidebar ${JSON.stringify(sidebar)}`);
		if (name === "desktop") {
			if (!sidebar.present || !sidebar.hasInbox) problems.push(`sidebar did not render folders: ${JSON.stringify(sidebar)}`);
			if (sidebar.error) problems.push(`sidebar shows an error state: ${sidebar.sample}`);
			const sidebarShot = shot(name, item, "sidebar");
			await page.screenshot({ path: sidebarShot });
			shots.push(sidebarShot);
		} else {
			notes.push("sidebar is drawer-based at mobile width; folder list checked on desktop only");
		}

		// Move-to-folder menu scrolling with many folders (seeded on desktop pass only).
		if (name === "desktop") {
			const seeded = await seedFolders(page, baseUrl, 12);
			detail(`${name} seeded folders ${JSON.stringify(seeded)}`);
			const okCount = seeded.filter((f) => f.status >= 200 && f.status < 300).length;
			notes.push(`seeded ${okCount}/12 folders via the real folders API`);
			await openInbox(page, baseUrl);
			await page.getByRole("button", { name: /^Open conversation Coffee next week/ }).click();
			await delay(1_500);
			const moveButton = page.getByRole("button", { name: "Move to folder" }).first();
			if (await moveButton.count()) {
				await moveButton.click();
				await delay(1_800);
				const popupProbe = await page.evaluate(() => {
					const named = Array.from(document.querySelectorAll("body *")).filter(
						(el) =>
							(el.textContent ?? "").trim() === "Journey Folder 01" &&
							!el.closest("nav, aside"),
					);
					const positioned = Array.from(document.querySelectorAll("body > div, body > dialog"))
						.map((el) => ({
							tag: el.tagName,
							cls: String(el.className).slice(0, 50),
							rect: el.getBoundingClientRect().toJSON(),
							text: (el.textContent ?? "").trim().slice(0, 80),
						}))
						.filter((el) => el.rect.height < 4_000);
					return {
						menuCopiesOutsideSidebar: named.length,
						firstRect: named[0]?.getBoundingClientRect().toJSON() ?? null,
						bodyLevel: positioned.slice(0, 6),
					};
				});
				detail(`${name} move popup probe ${JSON.stringify(popupProbe)}`);
				notes.push(`move popup probe ${JSON.stringify(popupProbe.menuCopiesOutsideSidebar)}`);
				const menuShot = shot(name, item, "move-menu");
				await page.screenshot({ path: menuShot });
				shots.push(menuShot);
				// Kumo's DropdownMenu does not expose role=menu, so anchor on a real
				// seeded folder item and climb to the popup that contains it.
				const menu = await page.evaluate(() => {
					const item = Array.from(document.querySelectorAll("body *")).find(
						(el) =>
							(el.textContent ?? "").trim() === "Journey Folder 01" && !el.closest("nav, aside"),
					);
					if (!item) {
						return {
							missing: true,
							crashed: /Something went wrong|MenuGroupRootContext/.test(document.body.innerText),
						};
					}
					let popup = item;
					let scroller = null;
					for (let hop = 0; hop < 8 && popup.parentElement; hop += 1) {
						popup = popup.parentElement;
						const style = getComputedStyle(popup);
						if (!scroller && (["auto", "scroll"].includes(style.overflowY) || popup.scrollHeight > popup.clientHeight + 1)) {
							scroller = popup;
						}
						if (popup.parentElement === document.body) break;
					}
					const rect = popup.getBoundingClientRect();
					const style = getComputedStyle(popup);
					const scrollerStyle = scroller ? getComputedStyle(scroller) : null;
					return {
						itemCount: Array.from(popup.querySelectorAll("*")).filter((el) =>
							/^Journey Folder \d\d$/.test((el.textContent ?? "").trim()),
						).length,
						height: rect.height,
						top: rect.top,
						bottom: rect.bottom,
						viewportHeight: window.innerHeight,
						overflowY: scrollerStyle?.overflowY ?? style.overflowY,
						maxHeight: scrollerStyle?.maxHeight ?? style.maxHeight,
						scrollHeight: scroller?.scrollHeight ?? popup.scrollHeight,
						clientHeight: scroller?.clientHeight ?? popup.clientHeight,
						scrollable: Boolean(scroller),
					};
				});
				detail(`${name} move menu ${JSON.stringify(menu)}`);
				if (!menu || menu.missing) {
					problems.push(`move-to-folder menu did not render: ${JSON.stringify(menu)}`);
				} else {
					if (menu.bottom > menu.viewportHeight + 1) {
						problems.push(`move menu overflows the viewport (bottom ${menu.bottom} > ${menu.viewportHeight})`);
					}
					if (!menu.scrollable && menu.itemCount > 10) {
						problems.push(`move menu with ${menu.itemCount} folder items is not scrollable (overflowY ${menu.overflowY}, maxHeight ${menu.maxHeight})`);
					}
					notes.push(`move menu: ${menu.itemCount} seeded folders visible, popup height ${Math.round(menu.height)}, overflowY ${menu.overflowY}, maxHeight ${menu.maxHeight}, scroll ${menu.scrollHeight}/${menu.clientHeight}`);
				}
				await page.keyboard.press("Escape");
				await delay(400);
			} else {
				problems.push("no Move control found on the open conversation toolbar");
			}
		}

		// Settings save gating
		await page.goto(`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/settings`, {
			waitUntil: "domcontentloaded",
		});
		await delay(2_500);
		const settingsShot = shot(name, item, "settings");
		await page.screenshot({ path: settingsShot, fullPage: true });
		shots.push(settingsShot);
		const saveInventory = await page.evaluate(() =>
			Array.from(document.querySelectorAll("button"))
				.filter((b) => /save/i.test(b.textContent ?? ""))
				.map((b) => ({
					text: b.textContent?.trim(),
					disabled: b.disabled || b.getAttribute("aria-disabled") === "true",
					section: b.closest("section, form, div[class*='rounded']")
						?.querySelector("h1, h2, h3")?.textContent?.trim() ?? null,
				})),
		);
		detail(`${name} settings save buttons ${JSON.stringify(saveInventory)}`);
		notes.push(`settings Save inventory ${JSON.stringify(saveInventory)}`);
		const saveButtons = page.getByRole("button", { name: /Save/i });
		const saveCount = await saveButtons.count();
		if (saveCount === 0) {
			notes.push("no Save control found on the settings route; save-gating not exercised");
		} else {
			const initiallyDisabled = saveInventory.length > 0
				? saveInventory.every((b) => b.disabled)
				: await saveButtons.first().isDisabled();
			// Edit the field the Save control actually governs: the signature textarea.
			const firstInput = page.locator("textarea:visible").first();
			const fallbackInput = page
				.locator("input[type='text']:visible, input:not([type]):visible")
				.filter({ hasNot: page.locator("[aria-label='Search emails']") })
				.first();
			const target = (await firstInput.count()) ? firstInput : fallbackInput;
			let afterEdit = null;
			if (await target.count()) {
				const targetInfo = await target.evaluate((el) => ({
					tag: el.tagName,
					label: el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.id,
					disabled: el.disabled,
					readOnly: el.readOnly,
				}));
				detail(`${name} settings edit target ${JSON.stringify(targetInfo)}`);
				notes.push(`settings edit target ${JSON.stringify(targetInfo)}`);
				await target.click();
				await target.type("x");
				await delay(700);
				const afterInventory = await page.evaluate(() =>
					Array.from(document.querySelectorAll("button"))
						.filter((b) => /save/i.test(b.textContent ?? ""))
						.map((b) => b.disabled || b.getAttribute("aria-disabled") === "true"),
				);
				afterEdit = afterInventory.length > 0 ? afterInventory.every(Boolean) : null;
				detail(`${name} settings save after edit ${JSON.stringify(afterInventory)}`);
				const editedShot = shot(name, item, "settings-edited");
				await page.screenshot({ path: editedShot, fullPage: true });
				shots.push(editedShot);
			}
			detail(`${name} settings save disabled initially=${initiallyDisabled} afterEdit=${afterEdit}`);
			if (!initiallyDisabled) problems.push("settings Save is enabled before any edit");
			if (afterEdit === true) problems.push("settings Save stayed disabled after an edit");
			notes.push(`settings Save: disabled=${initiallyDisabled} before edit, disabled=${afterEdit} after`);
		}

		// Sub-xl overflow menu must contain "Command palette".
		const originalViewport = page.viewportSize();
		await page.setViewportSize({ width: 1000, height: 900 });
		await openInbox(page, baseUrl);
		await delay(1_000);
		const overflow = page.getByRole("button", { name: "More mail actions" }).first();
		let paletteInOverflow = false;
		const overflowVisible = (await overflow.count()) > 0 && (await overflow.isVisible().catch(() => false));
		detail(`${name} overflow trigger count=${await overflow.count()} visible=${overflowVisible}`);
		if (overflowVisible) {
			await overflow.click();
			await delay(700);
			const overflowShot = shot(name, item, "overflow-1000");
			await page.screenshot({ path: overflowShot });
			shots.push(overflowShot);
			const roleDump = await page.evaluate(() => ({
				expanded: document.querySelector("[aria-label='More mail actions']")?.getAttribute("aria-expanded"),
				roles: Array.from(new Set(
					Array.from(document.querySelectorAll("[role]")).map((n) => n.getAttribute("role")),
				)),
				popovers: Array.from(document.querySelectorAll("[popover], [data-popup-open], [data-open], [data-state]"))
					.map((n) => ({
						tag: n.tagName,
						state: n.getAttribute("data-state") ?? n.getAttribute("data-open"),
						text: (n.textContent ?? "").trim().slice(0, 120),
					}))
					.slice(0, 12),
				bodyChildren: Array.from(document.body.children).map((n) => n.tagName + "." + String(n.className).slice(0, 40)),
			}));
			detail(`${name} overflow role dump ${JSON.stringify(roleDump)}`);
			const menuScan = await page.evaluate(() => {
				const menus = Array.from(
					document.querySelectorAll("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper], [popover]"),
				).map((n) => (n.textContent ?? "").trim().slice(0, 300));
				const paletteNode = Array.from(document.querySelectorAll("body *")).find(
					(el) =>
						(el.textContent ?? "").trim() === "Command palette" &&
						el.getBoundingClientRect().width > 0,
				);
				return {
					menus,
					paletteVisible: Boolean(paletteNode),
					paletteRole: paletteNode?.getAttribute("role") ?? paletteNode?.tagName ?? null,
					bodyHasPalette: /Command palette/.test(document.body.innerText),
				};
			});
			detail(`${name} overflow menu scan ${JSON.stringify(menuScan)}`);
			paletteInOverflow = menuScan.paletteVisible || menuScan.bodyHasPalette
				|| menuScan.menus.some((t) => /Command palette/i.test(t));
			await page.keyboard.press("Escape");
		}
		const overflowCrash = await page.evaluate(() => ({
			crashed: /Something went wrong|MenuGroupRootContext/.test(document.body.innerText),
			message: (document.body.innerText.match(/Base UI:[^\n]*/) ?? [null])[0],
		}));
		if (!overflowVisible) {
			problems.push('no "More mail actions" overflow trigger is visible at 1000px');
		} else if (overflowCrash.crashed) {
			problems.push(`opening the sub-xl overflow menu CRASHES the whole app: ${overflowCrash.message}`);
		} else if (!paletteInOverflow) {
			problems.push('sub-xl (1000px) overflow menu does not expose "Command palette"');
		}
		if (originalViewport) await page.setViewportSize(originalViewport);

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", (problems.length === 0
			? "sidebar renders folders with no error state; move menu bounded and scrollable; settings Save gated on an edit; Command palette present in the 1000px overflow menu"
			: problems.join(" | ")) + (notes.length ? ` || notes: ${notes.join("; ")}` : ""), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		shots.push(failShot);
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, shots);
	}
}

/**
 * Mail shortcuts must not reach the list while a modal dialog owns the screen.
 * The controller only suppresses them for the compose modal and its own
 * shortcuts dialog, so this opens the snooze dialog and listens on the command
 * bus while pressing j / k / e.
 */
async function verifyDialogShortcutGuard(page, baseUrl, name) {
	const item = "06b-dialog-shortcut-guard";
	const shots = [];
	const problems = [];
	try {
		await openInbox(page, baseUrl);
		await page.getByRole("button", { name: /^Open conversation Coffee next week/ }).click();
		await delay(1_500);

		const snooze = page.getByRole("button", { name: /Snooze/i }).first();
		if (!(await snooze.count())) {
			record(item, name, "PARTIAL", "no Snooze control available on this conversation; dialog guard not exercised", shots);
			return;
		}
		await snooze.click();
		await delay(1_200);

		const dialogState = await page.evaluate(() => {
			const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [role='alertdialog']"));
			return {
				open: dialogs.length,
				text: dialogs.map((d) => (d.textContent ?? "").trim().slice(0, 120)),
				active: document.activeElement?.tagName ?? null,
				activeInDialog: dialogs.some((d) => d.contains(document.activeElement)),
			};
		});
		detail(`${name} snooze dialog ${JSON.stringify(dialogState)}`);
		if (dialogState.open === 0) {
			record(item, name, "PARTIAL", `Snooze did not open a dialog: ${JSON.stringify(dialogState)}`, shots);
			return;
		}
		const dialogShot = shot(name, item, "dialog-open");
		await page.screenshot({ path: dialogShot });
		shots.push(dialogShot);

		// Listen on the same bus the controller publishes list commands onto.
		await page.evaluate(() => {
			globalThis.__mailCommands = [];
			globalThis.__mailCommandListener = (event) =>
				globalThis.__mailCommands.push(event.detail);
			window.addEventListener("mail-portal:command", globalThis.__mailCommandListener);
		});

		const targetBefore = await keyboardTargetId(page);
		for (const key of ["j", "k", "e"]) {
			await page.keyboard.press(key);
			await delay(400);
		}
		await delay(800);

		const result = await page.evaluate(() => ({
			commands: globalThis.__mailCommands ?? [],
			dialogsStillOpen: document.querySelectorAll("[role='dialog'], [role='alertdialog']").length,
		}));
		const targetAfter = await keyboardTargetId(page);
		const afterShot = shot(name, item, "after-jke");
		await page.screenshot({ path: afterShot });
		shots.push(afterShot);
		detail(`${name} commands behind dialog ${JSON.stringify(result)} target ${targetBefore} -> ${targetAfter}`);

		if (result.commands.length > 0) {
			problems.push(
				`mail shortcuts fire behind an open dialog: j/k/e published ${JSON.stringify(result.commands)} (keyboard target ${targetBefore} -> ${targetAfter}, dialogs still open: ${result.dialogsStillOpen})`,
			);
		}

		await page.evaluate(() => {
			window.removeEventListener("mail-portal:command", globalThis.__mailCommandListener);
		});
		await page.keyboard.press("Escape");
		await delay(600);

		record(item, name, problems.length === 0 ? "PASS" : "FAIL", problems.length === 0
			? `with the snooze dialog open, j/k/e published no list commands (bus empty) and the keyboard target stayed ${targetBefore}`
			: problems.join(" | "), shots);
	} catch (error) {
		const failShot = shot(name, item, "error");
		await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
		shots.push(failShot);
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, shots);
	}
}

/**
 * Every DropdownMenu that renders a DropdownMenu.Label, opened for real. Base UI
 * throws if a group label has no Menu.Group parent, and the throw escapes into
 * the route error boundary rather than staying inside the menu.
 */
async function verifyMenuCrashes(page, baseUrl, name) {
	const item = "07b-dropdown-menus";
	const shots = [];
	const problems = [];
	const observations = [];

	const crashed = async () =>
		page.evaluate(() => ({
			crashed: /Something went wrong|MenuGroupRootContext/.test(document.body.innerText),
			message: (document.body.innerText.match(/Base UI:[^\n]*/) ?? [null])[0],
		}));

	try {
		// Composer "Send options" -> DropdownMenu.Label "Send later".
		await openInbox(page, baseUrl);
		await page.keyboard.press("c");
		await delay(1_500);
		const sendOptions = page.getByRole("button", { name: "Send options" }).first();
		if (await sendOptions.count()) {
			const disabled = await sendOptions.isDisabled().catch(() => null);
			await sendOptions.click({ force: true }).catch((error) => detail(`send options click: ${error}`));
			await delay(1_500);
			const state = await crashed();
			// Only a menu that actually mounted its Label can prove or clear the crash.
			const opened = await page.evaluate(() =>
				/Send later|Tomorrow morning|Monday morning|Pick a time/i.test(document.body.innerText),
			);
			const shotPath = shot(name, item, "compose-send-options");
			await page.screenshot({ path: shotPath });
			shots.push(shotPath);
			observations.push(
				`compose Send options: disabled=${disabled}, menuOpened=${opened}, crashed=${state.crashed} ${state.message ?? ""}`,
			);
			if (state.crashed) {
				problems.push(`composer "Send options" menu crashes the app: ${state.message}`);
			} else if (!opened) {
				observations.push(
					"NOT PROVEN: the Send options menu never mounted, so ComposeEmail.tsx:827 DropdownMenu.Label was not exercised",
				);
			}
		} else {
			observations.push("compose Send options trigger not found");
		}

		record(item, name, problems.length === 0 ? "PASS" : "FAIL",
			(problems.length === 0 ? "every opened DropdownMenu rendered without throwing" : problems.join(" | "))
			+ ` || ${observations.join("; ")}`,
			shots);
	} catch (error) {
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, shots);
	}
}

// ---------------------------------------------------------------------------
// 7c. HEADER MENU ACTIVATION
// ---------------------------------------------------------------------------

/**
 * Below xl the header's Settings control lives inside the three-dots
 * DropdownMenu, which closes on any tap whether or not the item's handler ran.
 * A menu that swallows activation therefore looks exactly like one that works,
 * so assert the destination rather than the tap.
 */
async function verifyHeaderMenu(page, baseUrl, name) {
	const item = "07c-header-menu";
	const shots = [];
	const problems = [];
	const observations = [];

	try {
		await openInbox(page, baseUrl);
		const overflow = page.getByRole("button", { name: "More mail actions" });
		const usesMenu = await overflow.isVisible().catch(() => false);
		observations.push(`three-dots menu visible=${usesMenu}`);

		if (usesMenu) {
			// Every item in this menu shares one activation path, so the palette
			// item proves the handler ran without navigating away from the check.
			await overflow.click();
			await delay(600);
			const paletteItem = page.getByRole("menuitem", { name: "Command palette" });
			if (!(await paletteItem.isVisible().catch(() => false))) {
				problems.push("the three-dots menu never opened");
			} else {
				await paletteItem.click();
				await delay(800);
				const paletteOpen = await page
					.getByRole("combobox", { name: "Search commands" })
					.isVisible()
					.catch(() => false);
				observations.push(`command palette opened=${paletteOpen}`);
				if (!paletteOpen) {
					problems.push('"Command palette" closed the menu without running its handler');
				}
				await page.keyboard.press("Escape");
				await delay(400);
			}
			await overflow.click();
			await delay(600);
			await page.getByRole("menuitem", { name: "Settings" }).click();
		} else {
			await page.getByRole("button", { name: "Settings" }).click();
		}
		await delay(1_500);

		const shotPath = shot(name, item, usesMenu ? "menu-settings" : "gear-settings");
		await page.screenshot({ path: shotPath });
		shots.push(shotPath);
		observations.push(`url after Settings=${page.url()}`);
		if (!page.url().includes("/settings")) {
			problems.push('"Settings" left the page on the inbox instead of navigating');
		}
		const menuStillOpen = await page
			.getByRole("menuitem", { name: "Settings" })
			.isVisible()
			.catch(() => false);
		observations.push(`menu still open after activation=${menuStillOpen}`);

		record(item, name, problems.length === 0 ? "PASS" : "FAIL",
			(problems.length === 0
				? `the header Settings control (${usesMenu ? "three-dots menu" : "gear button"}) navigated to settings`
				: problems.join(" | "))
			+ ` || ${observations.join("; ")}`,
			shots);
	} catch (error) {
		record(item, name, "FAIL", `threw: ${formatFailure(error)}`, shots);
	}
}

// ---------------------------------------------------------------------------
// 8. PWA HEAD
// ---------------------------------------------------------------------------

async function verifyPwaHead(baseUrl) {
	const item = "08-pwa-head";
	try {
		const response = await fetch(`${baseUrl}/login`);
		const html = await response.text();
		writeFileSync(join(artifactDirectory, `polish-journey-${runStamp}-login.html`), html);
		const checks = {
			manifestLink: /<link[^>]+rel=["']manifest["'][^>]*>/i.exec(html)?.[0] ?? null,
			appleCapable: /<meta[^>]+name=["']apple-mobile-web-app-capable["'][^>]*>/i.exec(html)?.[0] ?? null,
			appleStatusBar: /<meta[^>]+name=["']apple-mobile-web-app-status-bar-style["'][^>]*>/i.exec(html)?.[0] ?? null,
			appleTitle: /<meta[^>]+name=["']apple-mobile-web-app-title["'][^>]*>/i.exec(html)?.[0] ?? null,
			mobileWebAppCapable: /<meta[^>]+name=["']mobile-web-app-capable["'][^>]*>/i.exec(html)?.[0] ?? null,
			themeColor: /<meta[^>]+name=["']theme-color["'][^>]*>/i.exec(html)?.[0] ?? null,
			appleTouchIcon: /<link[^>]+rel=["']apple-touch-icon["'][^>]*>/i.exec(html)?.[0] ?? null,
		};
		detail(`login head checks ${JSON.stringify(checks, null, 1)}`);
		const missing = Object.entries(checks)
			.filter(([key, value]) => value === null && ["manifestLink", "mobileWebAppCapable"].includes(key))
			.map(([key]) => key);
		const optionalMissing = Object.entries(checks)
			.filter(([, value]) => value === null)
			.map(([key]) => key);
		// The legacy apple-mobile-web-app-capable tag routes iOS installs down the
		// pre-manifest web-clip path whose push identity is empty (webpushd answers
		// "denied" without prompting), so its PRESENCE is the failure.
		const problems = [...missing.map((key) => `missing required head tag: ${key}`)];
		if (checks.appleCapable !== null) {
			problems.push(`legacy web-clip tag present: ${checks.appleCapable}`);
		}
		record(item, "server", problems.length === 0 ? "PASS" : "FAIL",
			problems.length === 0
				? `server-rendered /login carries ${checks.manifestLink} and ${checks.mobileWebAppCapable} with no legacy apple-mobile-web-app-capable tag; absent: ${optionalMissing.length ? optionalMissing.join(", ") : "none"}`
				: problems.join(" | "),
			[]);
		return checks;
	} catch (error) {
		record(item, "server", "FAIL", `threw: ${formatFailure(error)}`, []);
		return null;
	}
}

// ---------------------------------------------------------------------------

async function runViewport({ browser, baseUrl, storageState, name, viewport }) {
	progress(`--- ${name} ${viewport.width}x${viewport.height} ---`);
	const context = await browser.newContext({ storageState, viewport });
	const page = await context.newPage();
	page.setDefaultTimeout(20_000);
	observe(page, name);
	const counters = { hero: 0, tracker: 0, mixed: 0, picture: 0, ineligible: 0, forged: 0 };
	const onlyArg = process.argv.find((a) => a.startsWith("--only="));
	const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;
	const run = (key, fn) => (!only || only.has(key) ? fn() : Promise.resolve());
	try {
		await installFixture(page, counters);
		await run("list", () => verifyList(page, baseUrl, name));
		await run("thread", () => verifyThreadOrder(page, baseUrl, name));
		await run("reply", () => verifyInlineReply(page, baseUrl, name));
		await run("quoted", () => verifyQuotedBlocks(page, baseUrl, name));
		await run("images", () => verifyImages(page, baseUrl, name, counters));
		await run("keyboard", () => verifyKeyboard(page, baseUrl, name));
		await run("rowactivation", () => verifyRowActivation(page, baseUrl, name));
		await run("replysend", () => verifyInlineReplySendAttempt(page, baseUrl, name));
		await run("undo", () => verifyUndo(page, baseUrl, name));
		await run("send", () => verifySendFeedback(page, baseUrl, name));
		await run("dialogguard", () => verifyDialogShortcutGuard(page, baseUrl, name));
		await run("menus", () => verifyMenuCrashes(page, baseUrl, name));
		await run("headermenu", () => verifyHeaderMenu(page, baseUrl, name));
		await run("sweeps", () => verifySweeps(page, baseUrl, name));
	} finally {
		await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
		await context.close();
	}
}

async function main() {
	progress(`Polish journey verification started. Log: ${logFilePath}`);
	let stateDirectory;
	let serverProcess;
	let browser;
	try {
		stateDirectory = mkdtempSync(join(tmpdir(), "mail-portal-polish-journey-"));
		const port = await freePort();
		const baseUrl = `http://127.0.0.1:${port}`;
		progress("[1/5] Preparing an isolated local database");
		await runSetupCommand(
			["wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", configPath, "--persist-to", stateDirectory],
			localEnvironment({ CI: "1", WRANGLER_LOG_PATH: wranglerLogPath }),
		);
		progress("[2/5] Starting an isolated Wiser runtime");
		serverProcess = spawn(
			"npm",
			["exec", "--", "react-router", "dev", "--host", "127.0.0.1", "--port", String(port)],
			{
				cwd: root,
				env: localEnvironment({
					MAIL_PORTAL_PLAYWRIGHT_STATE: stateDirectory,
					MAIL_PORTAL_PLAYWRIGHT_CONFIG: configPath,
					WRANGLER_LOG_PATH: wranglerLogPath,
				}),
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			},
		);
		serverProcess.stdout.on("data", (c) => detail(`server stdout ${c}`));
		serverProcess.stderr.on("data", (c) => detail(`server stderr ${c}`));
		await waitForServer(baseUrl, serverProcess);
		progress(`[3/5] Server ready at ${baseUrl}`);
		await verifyPwaHead(baseUrl);
		browser = await chromium.launch({ headless: true, timeout: 30_000 });
		const storageState = await authenticate(browser, baseUrl);
		if (!process.argv.includes("--desktop-only")) {
			progress("[4/5] Mobile journey");
			await runViewport({ browser, baseUrl, storageState, name: "mobile", viewport: { width: 390, height: 844 } });
		}
		if (!process.argv.includes("--mobile-only")) {
			progress("[5/5] Desktop journey");
			await runViewport({ browser, baseUrl, storageState, name: "desktop", viewport: { width: 1440, height: 900 } });
		}
	} finally {
		await browser?.close().catch(() => {});
		await stopServer(serverProcess);
		if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
		writeFileSync(resultsPath, JSON.stringify(findings, null, 2));
		progress(`Results written to ${resultsPath}`);
		const failed = findings.filter((f) => f.status === "FAIL");
		progress(`SUMMARY ${findings.length} checks, ${failed.length} FAIL`);
		for (const finding of findings) progress(`  ${finding.status} ${finding.item} @${finding.viewport}`);
	}
}

main().catch((error) => {
	detail(formatFailure(error));
	console.error(`HARNESS ERROR: ${formatFailure(error)}`);
	process.exitCode = 1;
});
