import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const artifactDirectory = join(root, "script-logs");
const runStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const logFilePath = join(artifactDirectory, `email-body-playwright-${runStamp}.log`);
const wranglerLogPath = join(artifactDirectory, `wrangler-email-body-${runStamp}.log`);
const configPath = join(root, "scripts", "wrangler-email-body-playwright.jsonc");
const mailboxId = "playwright-email-body@wiserchat.ai";
const password = "LocalMailPortal!2026";
const selectedId = "selected-external";
const replyId = "older-external";
const threadId = "email-body-thread";
const subject = "Quarterly launch decision";
const selectedPreview = "SELECTED PREVIEW MUST NEVER REPLACE THE COMPLETE MESSAGE";
const replyPreview = "OLDER PREVIEW MUST NEVER REPLACE THE COMPLETE MESSAGE";
const selectedFullBody = "AUTHORITATIVE SELECTED BODY FOR FORWARDING";
const replyFullBody = "AUTHORITATIVE OLDER MESSAGE BODY";
const cidContentId = "inline-proof@example.com";
const cidAttachmentId = "inline-proof";
const cidSrcsetOnlyContentId = "srcset-only@example.com";
const cidSrcsetOnlyAttachmentId = "srcset-only";
const remoteTailLine = "TAIL LINE BELOW THE REMOTE BANNER";
const hostileId = "hostile-inline-metadata";
const hostileThreadId = "hostile-inline-metadata-thread";
const hostileSubject = "Hostile metadata switch";
const hostileBody = "SAFE HOSTILE METADATA MESSAGE";
const viewerLayoutId = "viewer-layout-single";
const viewerLayoutThreadId = "viewer-layout-thread";
const viewerLayoutSubject = "Viewer layout regression";
const viewerLayoutBody = Array.from(
	{ length: 24 },
	(_, index) => `<p>Viewer layout line ${index + 1}: the complete message remains readable in conversation scroll order.</p>`,
).join("");
const cidPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);
const emailListOnly = process.argv.includes("--email-list-only");
const cidOnly = process.argv.includes("--cid-only");
const viewerLayoutOnly = process.argv.includes("--viewer-layout-only");

mkdirSync(artifactDirectory, { recursive: true });

function logLine(channel, message) {
	appendFileSync(logFilePath, `${new Date().toISOString()} ${channel} ${message}\n`);
}

function progress(message) {
	console.log(message);
	logLine("PROGRESS", message);
}

function detail(message) {
	logLine("DETAIL", message);
}

function formatFailure(error) {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Rendered state of one image inside the email frame, hidden ones included. */
function imageBox(frame, alt) {
	return frame.locator(`img[alt="${alt}"]`).evaluate((image) => ({
		display: getComputedStyle(image).display,
		height: image.getBoundingClientRect().height,
	}));
}

function deferred() {
	let resolvePromise;
	const promise = new Promise((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function pollValue(readValue, acceptValue, label, timeoutMilliseconds = 15_000) {
	const deadline = Date.now() + timeoutMilliseconds;
	let value;
	while (Date.now() < deadline) {
		value = await readValue();
		if (acceptValue(value)) return value;
		await delay(50);
	}
	throw new Error(
		`${label} did not reach the expected state; last value: ${
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
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await new Promise((resolveClose, reject) =>
		server.close((error) => error ? reject(error) : resolveClose()),
	);
	return address.port;
}

async function runSetupCommand(args, environment) {
	const child = spawn("npx", args, {
		cwd: root,
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => detail(`setup stdout ${chunk}`));
	child.stderr.on("data", (chunk) => detail(`setup stderr ${chunk}`));
	const result = await new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (exitCode, signalCode) => resolveExit({ exitCode, signalCode }));
	});
	if (result.exitCode !== 0) {
		throw new Error(`Database setup exited with ${result.exitCode ?? result.signalCode}`);
	}
}

async function waitForServer(baseUrl, serverProcess) {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
			throw new Error(
				`Wiser test server exited with ${serverProcess.exitCode ?? serverProcess.signalCode}`,
			);
		}
		try {
			const response = await fetch(`${baseUrl}/login`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return;
		} catch {
			// The isolated local runtime has not bound its port yet.
		}
		await delay(250);
	}
	throw new Error("Wiser test server did not become ready within 45 seconds");
}

async function stopServer(serverProcess) {
	if (!serverProcess?.pid || serverProcess.exitCode !== null) return;
	try {
		process.kill(-serverProcess.pid, "SIGTERM");
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ESRCH") return;
		serverProcess.kill("SIGTERM");
	}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline && serverProcess.exitCode === null) await delay(50);
	if (serverProcess.exitCode !== null) return;
	try {
		process.kill(-serverProcess.pid, "SIGKILL");
	} catch (error) {
		if (!(error && typeof error === "object" && error.code === "ESRCH")) {
			serverProcess.kill("SIGKILL");
		}
	}
}

function fixtureEmail({ id, sender, date, preview }) {
	return {
		id,
		conversation_id: threadId,
		thread_id: threadId,
		folder_id: "inbox",
		subject,
		sender,
		recipient: mailboxId,
		date,
		read: true,
		starred: false,
		body: `<p>${preview}</p>`,
		body_external: true,
		attachments: [],
		labels: [],
	};
}

const selectedEmail = {
	...fixtureEmail({
		id: selectedId,
		sender: "alice@example.com",
		date: "2026-07-15T10:00:00.000Z",
		preview: selectedPreview,
	}),
	thread_count: 2,
	thread_unread_count: 0,
	participants: "alice@example.com, bob@example.com",
	snippet: selectedPreview,
};

const olderEmail = fixtureEmail({
	id: replyId,
	sender: "bob@example.com",
	date: "2026-07-14T10:00:00.000Z",
	preview: replyPreview,
});

async function authenticate(browser, baseUrl) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
	await page.getByLabel("Email").fill(mailboxId);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 });
	await page.goto(
		`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`,
		{ waitUntil: "domcontentloaded" },
	);
	await delay(3_000);
	const storageState = await context.storageState();
	await context.close();
	return storageState;
}

async function installMailFixture(page, handleBody) {
	const mailboxPrefix = `/api/v1/mailboxes/${mailboxId}`;
	await page.route("**/api/v1/mailboxes/**", async (route) => {
		const request = route.request();
		const path = decodeURIComponent(new URL(request.url()).pathname);
		if (request.method() !== "GET") {
			detail(`fixture continue ${request.method()} ${path}`);
			await route.continue();
			return;
		}
		if (path === `${mailboxPrefix}/emails`) {
			detail(`fixture fulfill list ${path}`);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ emails: [selectedEmail], totalCount: 1 }),
			});
			return;
		}
		if (path === `${mailboxPrefix}/emails/${selectedId}/body`) {
			detail(`fixture handle selected body ${path}`);
			await handleBody({ route, messageId: selectedId });
			return;
		}
		if (path === `${mailboxPrefix}/emails/${replyId}/body`) {
			detail(`fixture handle older body ${path}`);
			await handleBody({ route, messageId: replyId });
			return;
		}
		if (path === `${mailboxPrefix}/emails/${selectedId}`) {
			detail(`fixture fulfill metadata ${path}`);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(selectedEmail),
			});
			return;
		}
		if (path === `${mailboxPrefix}/threads/${threadId}`) {
			detail(`fixture fulfill thread ${path}`);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([selectedEmail, olderEmail]),
			});
			return;
		}
		detail(`fixture continue GET ${path}`);
		await route.continue();
	});
}

async function installViewerLayoutFixture(page) {
	const mailboxPrefix = `/api/v1/mailboxes/${mailboxId}`;
	const email = {
		id: viewerLayoutId,
		conversation_id: viewerLayoutThreadId,
		thread_id: viewerLayoutThreadId,
		folder_id: "inbox",
		subject: viewerLayoutSubject,
		sender: "contact@wiserchat.ai",
		recipient: mailboxId,
		date: "2026-07-19T10:44:00.000Z",
		read: true,
		starred: false,
		body: viewerLayoutBody,
		body_external: false,
		attachments: [],
		labels: [],
		thread_count: 1,
		thread_unread_count: 0,
		participants: "contact@wiserchat.ai",
		snippet: "Viewer layout line 1",
	};
	await page.route("**/api/v1/mailboxes/**", async (route) => {
		const request = route.request();
		const path = decodeURIComponent(new URL(request.url()).pathname);
		if (request.method() !== "GET") {
			await route.continue();
			return;
		}
		if (path === `${mailboxPrefix}/emails`) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ emails: [email], totalCount: 1 }),
			});
			return;
		}
		if (path === `${mailboxPrefix}/emails/${viewerLayoutId}`) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(email),
			});
			return;
		}
		if (path === `${mailboxPrefix}/threads/${viewerLayoutThreadId}`) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([email]),
			});
			return;
		}
		await route.continue();
	});
}

async function installCidFixture(page, counters) {
	const mailboxPrefix = `/api/v1/mailboxes/${mailboxId}`;
	const cidEmail = {
		...selectedEmail,
		thread_count: 1,
		attachments: [
			{
				id: cidAttachmentId,
				filename: "inline-proof.png",
				mimetype: "image/png",
				size: cidPng.byteLength,
				content_id: `<${cidContentId.toUpperCase()}>`,
				disposition: "inline",
			},
			{
				id: cidSrcsetOnlyAttachmentId,
				filename: "srcset-only.png",
				mimetype: "image/png",
				size: cidPng.byteLength,
				content_id: cidSrcsetOnlyContentId,
				disposition: "inline",
			},
			{
				id: "unreferenced-inline",
				filename: "private.png",
				mimetype: "image/png",
				size: cidPng.byteLength,
				content_id: "unreferenced@example.com",
				disposition: "inline",
			},
		],
	};
	const hostileEmail = {
		...fixtureEmail({
			id: hostileId,
			sender: "hostile-metadata@example.com",
			date: "2026-07-16T10:00:00.000Z",
			preview: "HOSTILE METADATA PREVIEW",
		}),
		conversation_id: hostileThreadId,
		thread_id: hostileThreadId,
		subject: hostileSubject,
		thread_count: 1,
		attachments: [
			{
				id: null,
				filename: "null-id.png",
				mimetype: "image/png",
				size: cidPng.byteLength,
				content_id: "null-id@example.com",
				disposition: "inline",
			},
			{
				id: "x".repeat(10_000),
				filename: {},
				mimetype: 3,
				size: cidPng.byteLength,
				content_id: [],
				disposition: "inline",
			},
		],
	};
	await page.route("https://tracker.example/**", async (route) => {
		counters.remoteTracker += 1;
		await route.fulfill({ status: 204 });
	});
	await page.route("https://override.example/**", async (route) => {
		counters.remoteOverride += 1;
		await route.fulfill({ status: 204 });
	});
	// Answers well after the bridge's last timed height report, so the frame can
	// only fit this banner by following the document as it actually reflows.
	await page.route("https://banner.example/**", async (route) => {
		counters.remoteBanner += 1;
		await delay(600);
		await route.fulfill({
			status: 200,
			contentType: "image/svg+xml",
			body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#2563eb"/></svg>',
		});
	});
	// Neither shape can ever render: http: dies on the https-only opt-in CSP and
	// on mixed content, and a relative src resolves against the portal instead of
	// the sender. Both must stay stripped even after the reader opts in.
	await page.route("http://insecure.example/**", async (route) => {
		counters.insecureRemote += 1;
		await route.fulfill({ status: 204 });
	});
	await page.route("**/relative-remote.png", async (route) => {
		counters.relativeRemote += 1;
		await route.fulfill({ status: 204 });
	});
	await page.route("**/api/v1/mailboxes/**", async (route) => {
		const request = route.request();
		const path = decodeURIComponent(new URL(request.url()).pathname);
		if (request.method() !== "GET") {
			await route.continue();
			return;
		}
		if (path === `${mailboxPrefix}/emails`) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ emails: [cidEmail, hostileEmail], totalCount: 2 }),
			});
			return;
		}
		if (path === `${mailboxPrefix}/emails/${selectedId}/body`) {
			await route.fulfill({
				status: 200,
				contentType: "text/plain",
				body: [
					"<p>Authenticated CID image:</p>",
					"<picture>",
					'<source srcset="https://override.example/cid-picture.png 1x">',
					`<img alt="CID render proof" src="CID:${cidContentId.toUpperCase()}" srcset="https://override.example/cid-image.png 2x" style="width:24px;height:24px">`,
					"</picture>",
					`<img alt="CID srcset only" srcset="CID:${cidSrcsetOnlyContentId.toUpperCase()} 1x">`,
					'<img alt="Remote tracker" src="https://tracker.example/pixel.png">',
					'<img alt="Remote banner" src="https://banner.example/banner.svg">',
					'<img alt="Insecure remote" src="http://insecure.example/pixel.png">',
					'<img alt="Relative remote" src="/relative-remote.png">',
					`<p>${remoteTailLine}</p>`,
				].join(""),
			});
			return;
		}
		if (path === `${mailboxPrefix}/emails/${selectedId}`) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(cidEmail),
			});
			return;
		}
		if (path === `${mailboxPrefix}/emails/${hostileId}/body`) {
			await route.fulfill({
				status: 200,
				contentType: "text/plain",
				body: `<p>${hostileBody}</p>`,
			});
			return;
		}
		if (path === `${mailboxPrefix}/emails/${hostileId}`) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(hostileEmail),
			});
			return;
		}
		if (path === `${mailboxPrefix}/threads/${threadId}`) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([cidEmail]),
			});
			return;
		}
		if (path === `${mailboxPrefix}/threads/${hostileThreadId}`) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([hostileEmail]),
			});
			return;
		}
		if (path === `${mailboxPrefix}/emails/${selectedId}/attachments/${cidAttachmentId}`) {
			counters.referenced += 1;
			await counters.attachmentGate.promise;
			await route.fulfill({
				status: 200,
				contentType: "image/png",
				body: cidPng,
			});
			return;
		}
		if (path === `${mailboxPrefix}/emails/${selectedId}/attachments/${cidSrcsetOnlyAttachmentId}`) {
			counters.srcsetOnly += 1;
			await route.fulfill({
				status: 200,
				contentType: "image/png",
				body: cidPng,
			});
			return;
		}
		if (path.includes("/attachments/unreferenced-inline")) {
			counters.unreferenced += 1;
			await route.fulfill({
				status: 200,
				contentType: "image/png",
				body: cidPng,
			});
			return;
		}
		await route.continue();
	});
}

async function verifyEmailListRetry({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	observeBrowser(page, `${name} email-list-retry`);
	const mailboxPrefix = `/api/v1/mailboxes/${mailboxId}`;
	let allowSuccess = false;
	let listRequests = 0;
	try {
		await page.route("**/api/v1/mailboxes/**", async (route) => {
			const request = route.request();
			const path = decodeURIComponent(new URL(request.url()).pathname);
			if (request.method() !== "GET" || path !== `${mailboxPrefix}/emails`) {
				await route.continue();
				return;
			}
			listRequests += 1;
			if (!allowSuccess) {
				await route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({ error: "fixture list unavailable" }),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ emails: [selectedEmail], totalCount: 1 }),
			});
		});

		await page.goto(
			`${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`,
			{ waitUntil: "domcontentloaded" },
		);
		const loadError = page.getByRole("alert").filter({
			hasText: "Conversations could not be loaded",
		});
		await loadError.waitFor();
		assert.equal(
			await page.getByRole("heading", { name: "Your inbox is empty" }).count(),
			0,
			"a failed list read must not claim the inbox is empty",
		);
		assert.ok(listRequests >= 1);
		const requestsAtSettledError = listRequests;
		await delay(1_000);
		assert.equal(
			listRequests,
			requestsAtSettledError,
			"a settled list error must wait for explicit retry",
		);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-list-error.png`),
		});

		allowSuccess = true;
		await loadError.getByRole("button", { name: "Try again" }).click();
		await page
			.getByRole("button", { name: `Open conversation ${subject}` })
			.waitFor();
		assert.equal(await loadError.count(), 0);
		assert.equal(listRequests, requestsAtSettledError + 1);
		await assertNoHorizontalOverflow(page);
		detail(`${name} list failure stayed truthful and recovered on one explicit retry`);
	} catch (error) {
		await captureDiagnostic(page, name, "email-list-retry", error);
		throw error;
	} finally {
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.close();
	}
}

async function openConversation(page, baseUrl) {
	const inboxUrl = `${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await page.goto(inboxUrl, { waitUntil: "domcontentloaded" });
		const open = page.getByRole("button", { name: `Open conversation ${subject}` });
		try {
			await open.waitFor({ timeout: 8_000 });
			await open.click();
			await page.getByRole("heading", { name: subject }).waitFor();
			return;
		} catch (error) {
			detail(`open conversation attempt ${attempt} at ${page.url()}: ${formatFailure(error)}`);
			if (attempt === 3) throw error;
			await delay(1_000);
		}
	}
}

function observeBrowser(page, scenario) {
	page.on("console", (message) => {
		if (message.type() === "error") detail(`${scenario} console error ${message.text()}`);
	});
	page.on("pageerror", (error) => detail(`${scenario} page error ${formatFailure(error)}`));
}

async function captureDiagnostic(page, name, scenario, error) {
	detail(`${name} ${scenario} failed at ${page.url()}: ${formatFailure(error)}`);
	detail(`${name} ${scenario} body ${(await page.locator("body").innerText()).slice(0, 6_000)}`);
	await page.screenshot({
		path: join(artifactDirectory, `email-body-${runStamp}-${name}-${scenario}-diagnostic.png`),
		fullPage: true,
	});
}

async function assertNoHorizontalOverflow(page) {
	const geometry = await page.evaluate(() => ({
		viewport: window.innerWidth,
		document: document.scrollingElement?.scrollWidth ?? 0,
	}));
	assert.ok(geometry.document <= geometry.viewport, JSON.stringify(geometry));
}

async function assertAuthoritativeIframe(page, messageId, expectedBody, forbiddenPreview) {
	const iframe = page
		.locator(`[data-intelligence-message-id="${messageId}"]`)
		.getByTitle("Email content");
	await iframe.waitFor();
	const srcdoc = await pollValue(
		() => iframe.getAttribute("srcdoc"),
		(value) => typeof value === "string" && value.includes(expectedBody),
		`authoritative body for ${messageId}`,
	);
	assert.match(srcdoc, new RegExp(expectedBody));
	assert.doesNotMatch(srcdoc, new RegExp(forbiddenPreview));
}

async function verifyViewerLayout({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	observeBrowser(page, `${name} viewer-layout`);
	try {
		await installViewerLayoutFixture(page);
		const inboxUrl = `${baseUrl}/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`;
		await page.goto(inboxUrl, { waitUntil: "domcontentloaded" });
		await page
			.getByRole("button", { name: `Open conversation ${viewerLayoutSubject}` })
			.click();
		await page.getByRole("heading", { name: viewerLayoutSubject }).waitFor();
		const iframe = page
			.locator(`[data-intelligence-message-id="${viewerLayoutId}"]`)
			.getByTitle("Email content");
		await iframe.waitFor();
		const iframeHandle = await iframe.elementHandle();
		assert.ok(iframeHandle);
		const contentFrame = await iframeHandle.contentFrame();
		assert.ok(contentFrame);
		await contentFrame.getByText("Viewer layout line 24", { exact: false }).waitFor();
		const geometry = await pollValue(
			() => Promise.all([
				iframe.evaluate((element) => ({
					height: element.getBoundingClientRect().height,
					top: element.getBoundingClientRect().top,
					bottom: element.getBoundingClientRect().bottom,
				})),
				contentFrame.evaluate(() => ({
					clientHeight: document.documentElement.clientHeight,
					scrollHeight: document.documentElement.scrollHeight,
				})),
			]).then(([frame, content]) => ({ frame, content })),
			(value) => value.content.scrollHeight > 0,
			"viewer layout iframe geometry",
		);
		assert.ok(
			geometry.content.scrollHeight <= geometry.content.clientHeight + 1,
			`email iframe owns an internal vertical scrollbar: ${JSON.stringify(geometry)}`,
		);
		assert.ok(
			geometry.frame.height >= geometry.content.scrollHeight - 1,
			`email iframe clips the message body: ${JSON.stringify(geometry)}`,
		);
		const intelligence = page.getByRole("button", { name: "Intelligence" });
		const activity = page.getByRole("button", { name: "Activity" });
		await intelligence.waitFor();
		await activity.waitFor();
		const order = await Promise.all([
			iframe.evaluate((element) => element.getBoundingClientRect().top),
			intelligence.evaluate((element) => element.getBoundingClientRect().top),
			activity.evaluate((element) => element.getBoundingClientRect().top),
		]);
		assert.ok(order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
		await assertNoHorizontalOverflow(page);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-viewer-layout-mail.png`),
		});
		await intelligence.evaluate((element) =>
			element.scrollIntoView({ block: "start" })
		);
		await delay(100);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-viewer-layout-tools.png`),
		});
		detail(`${name} viewer keeps long mail fully readable before Intelligence and Activity`);
	} catch (error) {
		await captureDiagnostic(page, name, "viewer-layout", error);
		throw error;
	} finally {
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.close();
	}
}

async function verifyInlineCidRendering({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	observeBrowser(page, `${name} inline-cid`);
	const attachmentGate = deferred();
	const counters = {
		attachmentGate,
		referenced: 0,
		unreferenced: 0,
		srcsetOnly: 0,
		remoteTracker: 0,
		remoteOverride: 0,
		remoteBanner: 0,
		insecureRemote: 0,
		relativeRemote: 0,
	};
	try {
		await installCidFixture(page, counters);
		await openConversation(page, baseUrl);
		const iframe = page
			.locator(`[data-intelligence-message-id="${selectedId}"]`)
			.getByTitle("Email content");
		await iframe.waitFor();
		const iframeHandle = await iframe.elementHandle();
		assert.ok(iframeHandle);
		const contentFrame = await iframeHandle.contentFrame();
		assert.ok(contentFrame);
		const inlineImage = contentFrame.locator('img[alt="CID render proof"]');
		await inlineImage.waitFor();
		await pollValue(
			() => counters.referenced,
			(value) => value === 1,
			"gated authenticated CID download",
		);
		await pollValue(
			() => contentFrame.evaluate(() => document.readyState),
			(value) => value === "complete",
			"opaque CID iframe readiness",
		);
		assert.equal(await inlineImage.getAttribute("src"), null);
		assert.equal(await inlineImage.getAttribute("srcset"), null);
		assert.equal(
			await contentFrame.locator("picture source").getAttribute("srcset"),
			null,
		);
		assert.equal(
			await contentFrame.locator('img[alt="CID srcset only"]').getAttribute("srcset"),
			null,
		);
		assert.equal(
			await contentFrame.locator('img[alt="Remote tracker"]').getAttribute("src"),
			null,
		);

		const srcdoc = await iframe.getAttribute("srcdoc");
		assert.ok(srcdoc);
		const nonceMatch = srcdoc.match(/var nonce = ("(?:[^"\\]|\\.)*");/);
		assert.ok(nonceMatch);
		const nonce = JSON.parse(nonceMatch[1]);
		const exactBytes = Array.from(cidPng);
		const postInlinePayload = async ({ payloadNonce, cid, mimeType, bytes, size }) => {
			await iframe.evaluate((element, input) => {
				const target = element.contentWindow;
				if (!target) throw new Error("Email iframe has no content window");
				const payloadBytes = input.bytes === null
					? new Uint8Array(input.size)
					: new Uint8Array(input.bytes);
				target.postMessage({
					__emailIframeInlineImages: true,
					nonce: input.payloadNonce,
					images: [{
						cid: input.cid,
						blob: new Blob([payloadBytes], { type: input.mimeType }),
					}],
				}, "*");
			}, { payloadNonce, cid, mimeType, bytes, size });
		};

		await contentFrame.evaluate(() => {
			const revoked = [];
			globalThis.__revokedInlineImageUrls = revoked;
			const originalRevoke = URL.revokeObjectURL.bind(URL);
			URL.revokeObjectURL = (url) => {
				revoked.push(url);
				originalRevoke(url);
			};
		});
		await postInlinePayload({
			payloadNonce: "forged-nonce",
			cid: cidContentId,
			mimeType: "image/png",
			bytes: exactBytes,
			size: 0,
		});
		await postInlinePayload({
			payloadNonce: nonce,
			cid: "unexpected@example.com",
			mimeType: "image/png",
			bytes: exactBytes,
			size: 0,
		});
		await postInlinePayload({
			payloadNonce: nonce,
			cid: cidContentId,
			mimeType: "image/png",
			bytes: [1],
			size: 0,
		});
		await postInlinePayload({
			payloadNonce: nonce,
			cid: cidContentId,
			mimeType: "image/gif",
			bytes: exactBytes,
			size: 0,
		});
		await postInlinePayload({
			payloadNonce: nonce,
			cid: cidContentId,
			mimeType: "image/png",
			bytes: null,
			size: 25 * 1024 * 1024 + 1,
		});
		await delay(100);
		assert.equal(await inlineImage.getAttribute("src"), null);
		assert.deepEqual(
			await contentFrame.evaluate(() => globalThis.__revokedInlineImageUrls),
			[],
		);

		attachmentGate.resolve();
		const initialState = await pollValue(
			() => inlineImage.evaluate((image) => ({
				complete: image.complete,
				naturalWidth: image.naturalWidth,
				naturalHeight: image.naturalHeight,
				source: image.src,
			})),
			(value) => value.complete && value.naturalWidth === 1 &&
				value.naturalHeight === 1 && value.source.startsWith("blob:"),
			"authenticated CID image render",
		);
		assert.equal(counters.referenced, 1);
		assert.equal(counters.unreferenced, 0);
		assert.equal(counters.srcsetOnly, 0);
		assert.equal(counters.remoteTracker, 0);
		assert.equal(counters.remoteOverride, 0);

		await postInlinePayload({
			payloadNonce: nonce,
			cid: cidContentId.toUpperCase(),
			mimeType: "image/png",
			bytes: exactBytes,
			size: 0,
		});
		await delay(100);
		assert.equal(await inlineImage.getAttribute("src"), initialState.source);
		assert.deepEqual(
			await contentFrame.evaluate(() => globalThis.__revokedInlineImageUrls),
			[],
		);

		await assertNoHorizontalOverflow(page);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-inline-cid.png`),
		});

		// A blocked message shows no broken-image glyphs and no alt-text boxes:
		// every image without a usable source is hidden outright.
		for (const alt of [
			"Remote tracker",
			"Remote banner",
			"Insecure remote",
			"Relative remote",
			"CID srcset only",
		]) {
			const box = await imageBox(contentFrame, alt);
			assert.equal(box.display, "none", `${alt} renders a glyph while blocked`);
		}
		assert.equal(counters.remoteBanner, 0);
		assert.equal(counters.insecureRemote, 0);
		assert.equal(counters.relativeRemote, 0);
		const blockedFrameHeight = await iframe.evaluate(
			(element) => element.getBoundingClientRect().height,
		);

		await page.getByRole("button", { name: "Load images" }).click();
		await pollValue(
			() => counters.remoteTracker,
			(value) => value === 1,
			"explicit remote tracker opt-in",
		);
		const optedInIframeHandle = await iframe.elementHandle();
		assert.ok(optedInIframeHandle);
		const optedInContentFrame = await optedInIframeHandle.contentFrame();
		assert.ok(optedInContentFrame);
		const optedInInlineImage = optedInContentFrame.locator('img[alt="CID render proof"]');
		await pollValue(
			() => optedInInlineImage.evaluate((image) => ({
				complete: image.complete,
				naturalWidth: image.naturalWidth,
				source: image.src,
			})),
			(value) => value.complete && value.naturalWidth === 1 && value.source.startsWith("blob:"),
			"CID image after remote opt-in",
		);
		assert.equal(await optedInInlineImage.getAttribute("srcset"), null);
		assert.equal(
			await optedInContentFrame.locator("picture source").getAttribute("srcset"),
			null,
		);
		assert.equal(counters.remoteOverride, 0);
		assert.equal(counters.srcsetOnly, 0);
		assert.equal(counters.referenced, 2);

		// Loading images has to visibly work: the banner answers ~600ms after the
		// document is parsed, so the frame can only fit it — and keep the line
		// below it unclipped — by following the document as it reflows.
		await pollValue(
			() => counters.remoteBanner,
			(value) => value === 1,
			"explicit remote banner opt-in",
		);
		const bannerBox = await pollValue(
			() => imageBox(optedInContentFrame, "Remote banner"),
			(value) => value.display !== "none" && value.height > 100,
			"opted-in remote banner render",
		);
		const grown = await pollValue(
			() => Promise.all([
				iframe.evaluate((element) => element.getBoundingClientRect().height),
				optedInContentFrame.evaluate(() => ({
					clientHeight: document.documentElement.clientHeight,
					scrollHeight: document.documentElement.scrollHeight,
				})),
			]).then(([frameHeight, content]) => ({ frameHeight, content })),
			(value) =>
				value.content.scrollHeight <= value.content.clientHeight + 1 &&
				value.frameHeight >= bannerBox.height &&
				value.frameHeight > blockedFrameHeight,
			"remote opt-in grows the frame to fit late images",
		);
		assert.ok(
			grown.frameHeight >= grown.content.scrollHeight - 1,
			`opted-in email iframe clips the message body: ${JSON.stringify(grown)}`,
		);
		await optedInContentFrame.getByText(remoteTailLine).waitFor();
		// http: and relative sources can never render, so opting in leaves them
		// stripped and hidden rather than turning them into broken glyphs.
		for (const alt of ["Insecure remote", "Relative remote"]) {
			const box = await imageBox(optedInContentFrame, alt);
			assert.equal(box.display, "none", `${alt} renders a glyph after opt-in`);
		}
		assert.equal(counters.insecureRemote, 0);
		assert.equal(counters.relativeRemote, 0);
		await assertNoHorizontalOverflow(page);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-remote-opt-in.png`),
		});

		const backToList = page.getByRole("button", { name: "Back to list" });
		if (await backToList.isVisible()) await backToList.click();
		await page
			.getByRole("button", { name: `Open conversation ${hostileSubject}` })
			.click();
		await page.getByRole("heading", { name: hostileSubject }).waitFor();
		const hostileIframe = page
			.locator(`[data-intelligence-message-id="${hostileId}"]`)
			.getByTitle("Email content");
		await hostileIframe.waitFor();
		const firstHostileSrcdoc = await hostileIframe.getAttribute("srcdoc");
		assert.doesNotMatch(firstHostileSrcdoc ?? "", /Authenticated CID image/);
		const settledHostileSrcdoc = await pollValue(
			() => hostileIframe.getAttribute("srcdoc"),
			(value) => typeof value === "string" && value.includes(hostileBody),
			"hostile metadata message render",
		);
		assert.doesNotMatch(settledHostileSrcdoc, /Authenticated CID image/);
		await assertNoHorizontalOverflow(page);
		detail(`${name} rejected pre-acceptance nonce, manifest, MIME, size, and aggregate attacks; ignored valid replay; preserved CID over responsive remote sources; and cleared prior private content on hostile metadata switch`);
	} catch (error) {
		await captureDiagnostic(page, name, "inline-cid", error);
		throw error;
	} finally {
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.close();
	}
}

async function verifyDelayedSelected({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	observeBrowser(page, `${name} delayed-selected`);
	const gate = deferred();
	let selectedRequests = 0;
	try {
		await installMailFixture(page, async ({ route, messageId }) => {
			if (messageId !== selectedId) {
				await route.fulfill({ status: 200, contentType: "text/plain", body: replyFullBody });
				return;
			}
			selectedRequests += 1;
			await gate.promise;
			await route.fulfill({ status: 200, contentType: "text/plain", body: selectedFullBody });
		});
		await openConversation(page, baseUrl);
		await page.getByText("alice@example.com", { exact: true }).first().waitFor();
		await page.getByRole("status").filter({
			hasText: "Loading complete message from alice@example.com…",
		}).waitFor();
		const unavailableForward = page.getByRole("button", {
			name: "Forward unavailable: Loading complete message",
		});
		assert.equal(await unavailableForward.isDisabled(), true);
		assert.equal(selectedRequests, 1);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-loading.png`),
		});

		gate.resolve();
		await assertAuthoritativeIframe(page, selectedId, selectedFullBody, selectedPreview);
		assert.equal(selectedRequests, 1);
		const forward = page.getByRole("button", { name: "Forward", exact: true });
		assert.equal(await forward.isEnabled(), true);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-loaded.png`),
		});
		await forward.click();
		const editor = page.getByLabel("Message body", { exact: true });
		await editor.waitFor();
		const editorHtml = await pollValue(
			() => editor.innerHTML(),
			(value) => value.includes(selectedFullBody),
			"Forward composer authoritative body",
		);
		assert.match(editorHtml, new RegExp(selectedFullBody));
		assert.doesNotMatch(editorHtml, new RegExp(selectedPreview));
		assert.equal(selectedRequests, 1);
		await assertNoHorizontalOverflow(page);
		detail(`${name} delayed selected body used one request and Forward used authoritative content`);
	} catch (error) {
		await captureDiagnostic(page, name, "delayed-selected", error);
		throw error;
	} finally {
		gate.resolve();
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.close();
	}
}

async function verifyCollapseCancellation({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	observeBrowser(page, `${name} collapse-cancellation`);
	const replyGate = deferred();
	let selectedRequests = 0;
	let replyRequests = 0;
	const replyFailure = deferred();
	page.on("requestfailed", (request) => {
		if (decodeURIComponent(new URL(request.url()).pathname).endsWith(`/emails/${replyId}/body`)) {
			replyFailure.resolve(request.failure()?.errorText ?? "unknown");
		}
	});
	try {
		await installMailFixture(page, async ({ route, messageId }) => {
			if (messageId === selectedId) {
				selectedRequests += 1;
				await route.fulfill({ status: 200, contentType: "text/plain", body: selectedFullBody });
				return;
			}
			replyRequests += 1;
			await replyGate.promise;
			await route.fulfill({ status: 200, contentType: "text/plain", body: replyFullBody });
		});
		await openConversation(page, baseUrl);
		await assertAuthoritativeIframe(page, selectedId, selectedFullBody, selectedPreview);
		const older = page.locator(`[data-intelligence-message-id="${replyId}"]`);
		await older.waitFor();
		await older.getByRole("button").first().click();
		await older.getByText("Loading complete message from bob@example.com…").waitFor();
		assert.equal(replyRequests, 1);
		await older.getByRole("button", { name: "Collapse message" }).first().click();
		const errorText = await Promise.race([
			replyFailure.promise,
			delay(5_000).then(() => "timeout"),
		]);
		assert.equal(errorText, "net::ERR_ABORTED");
		assert.equal(selectedRequests, 1);
		assert.equal(replyRequests, 1);
		assert.equal(await page.getByRole("button", { name: "Forward", exact: true }).isEnabled(), true);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-collapse-abort.png`),
		});
		await assertNoHorizontalOverflow(page);
		detail(`${name} collapse aborted only the older body request`);
	} catch (error) {
		await captureDiagnostic(page, name, "collapse-cancellation", error);
		throw error;
	} finally {
		replyGate.resolve();
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.close();
	}
}

async function verifyRetryRecovery({ context, baseUrl, name }) {
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	observeBrowser(page, `${name} retry-recovery`);
	let selectedRequests = 0;
	try {
		await installMailFixture(page, async ({ route, messageId }) => {
			if (messageId !== selectedId) {
				await route.fulfill({ status: 200, contentType: "text/plain", body: replyFullBody });
				return;
			}
			selectedRequests += 1;
			if (selectedRequests === 1) {
				await route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({
						error: "Complete message body is temporarily unavailable",
						code: "BODY_OBJECT_UNAVAILABLE",
					}),
				});
				return;
			}
			await route.fulfill({ status: 200, contentType: "text/plain", body: selectedFullBody });
		});
		await openConversation(page, baseUrl);
		const alert = page.getByRole("alert").filter({ hasText: "Complete message unavailable" });
		await alert.waitFor();
		await alert.getByText(
			"The complete message from alice@example.com could not be loaded.",
			{ exact: true },
		).waitFor();
		assert.equal(
			await page
				.locator(`[data-intelligence-message-id="${selectedId}"]`)
				.getByTitle("Email content")
				.count(),
			0,
		);
		const unavailableForward = page.getByRole("button", {
			name: "Forward unavailable: Complete message unavailable",
		});
		assert.equal(await unavailableForward.isDisabled(), true);
		assert.equal(selectedRequests, 1);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-error.png`),
		});
		await alert.getByRole("button", {
			name: "Retry loading complete message from alice@example.com",
		}).click();
		await assertAuthoritativeIframe(page, selectedId, selectedFullBody, selectedPreview);
		assert.equal(selectedRequests, 2);
		assert.equal(await page.getByRole("button", { name: "Forward", exact: true }).isEnabled(), true);
		await page.screenshot({
			path: join(artifactDirectory, `email-body-${runStamp}-${name}-recovered.png`),
		});
		await assertNoHorizontalOverflow(page);
		detail(`${name} retry recovered on the second explicit request without preview fallback`);
	} catch (error) {
		await captureDiagnostic(page, name, "retry-recovery", error);
		throw error;
	} finally {
		await page.unrouteAll({ behavior: "ignoreErrors" });
		await page.close();
	}
}

async function verifyViewport({ browser, baseUrl, storageState, name, viewport }) {
	progress(`Verifying ${name} at ${viewport.width}x${viewport.height}`);
	const context = await browser.newContext({ storageState, viewport });
	try {
		if (viewerLayoutOnly) {
			await verifyViewerLayout({ context, baseUrl, name });
			return;
		}
		if (cidOnly) {
			await verifyInlineCidRendering({ context, baseUrl, name });
			return;
		}
		await verifyEmailListRetry({ context, baseUrl, name });
		if (emailListOnly) return;
		await verifyViewerLayout({ context, baseUrl, name });
		await verifyInlineCidRendering({ context, baseUrl, name });
		await verifyDelayedSelected({ context, baseUrl, name });
		await verifyCollapseCancellation({ context, baseUrl, name });
		await verifyRetryRecovery({ context, baseUrl, name });
	} finally {
		await context.close();
	}
}

async function main() {
	progress(`Email body Playwright verification started. Detailed log: ${logFilePath}`);
	let stateDirectory;
	let serverProcess;
	let browser;
	try {
		stateDirectory = mkdtempSync(join(tmpdir(), "mail-portal-email-body-"));
		const port = await freePort();
		const baseUrl = `http://127.0.0.1:${port}`;
		progress("[1/5] Preparing an isolated local database");
		await runSetupCommand(
			[
				"wrangler", "d1", "migrations", "apply", "DB", "--local",
				"--config", configPath, "--persist-to", stateDirectory,
			],
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
		serverProcess.stdout.on("data", (chunk) => detail(`server stdout ${chunk}`));
		serverProcess.stderr.on("data", (chunk) => detail(`server stderr ${chunk}`));
		await waitForServer(baseUrl, serverProcess);
		browser = await chromium.launch({ headless: true, timeout: 15_000 });
		progress("[3/5] Bootstrapping the isolated authenticated session");
		const storageState = await authenticate(browser, baseUrl);
		progress("[4/5] Running mobile-first verification");
		await verifyViewport({
			browser,
			baseUrl,
			storageState,
			name: "mobile",
			viewport: { width: 390, height: 844 },
		});
		progress("[5/5] Running desktop verification");
		await verifyViewport({
			browser,
			baseUrl,
			storageState,
			name: "desktop",
			viewport: { width: 1440, height: 900 },
		});
		let passMessage =
			"PASS: email-list failures are truthful and recoverable, long mail is unclipped, and authoritative email bodies are exact, cancellable, retryable, and Forward-safe at both widths";
		if (viewerLayoutOnly) {
			passMessage =
				"PASS: long single-message mail owns no internal vertical scrollbar and precedes Intelligence and Activity at both widths";
		} else if (cidOnly) {
			passMessage =
				"PASS: CID inline images render through the nonce-bound opaque bridge at both widths";
		} else if (emailListOnly) {
			passMessage =
				"PASS: email-list failures are truthful and recoverable at both widths";
		}
		progress(passMessage);
	} finally {
		await browser?.close();
		await stopServer(serverProcess);
		if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
	}
}

main().catch((error) => {
	detail(formatFailure(error));
	console.error(`FAIL: email body Playwright verification failed. See ${logFilePath}`);
	process.exitCode = 1;
});
