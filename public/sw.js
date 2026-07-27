// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Mail portal service worker (WISER-240). Three jobs, ported from the Whispyr
// CRM stack:
//   1. `push`             → render the OS notification via showNotification().
//   2. `notificationclick`→ focus an existing app window (or open one) and
//                           navigate to the message's deep link.
//   3. `fetch` (no-op)    → required for Chrome's installability heuristic
//                           (fires beforeinstallprompt). Intentionally NO
//                           caching — no offline experience in v1.
//
// Bump SW_VERSION when the handler shape changes. Freshness comes from the
// registration's `updateViaCache: "none"` (app/components/pwa/
// ServiceWorkerRegistrar.tsx), which makes the browser bypass its HTTP cache
// for this file, so browsers refetch + swap on next load.

const SW_VERSION = "notif-v3";

self.addEventListener("install", () => {
	// Take over immediately instead of waiting for every old tab to close.
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	// Control open tabs right away, so push delivery doesn't need a reload.
	event.waitUntil(self.clients.claim());
});

// No-op passthrough. Do NOT remove — Chrome requires a fetch handler to treat
// the app as installable. If offline caching is ever added, it goes here.
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
	if (!event.data) return;

	let payload;
	try {
		payload = event.data.json();
	} catch (err) {
		console.error("[sw] failed to parse push payload", err);
		return;
	}

	const { title, body, icon, badge, clickUrl, data } = payload;
	const notificationTag =
		data && typeof data.emailId === "string" && data.emailId
			? data.emailId
			: undefined;

	// showNotification requires a non-empty title; fall back so a malformed
	// payload never renders "undefined" or throws.
	event.waitUntil(
		self.registration.showNotification(title || "New mail", {
			body: body || "",
			icon,
			badge,
			tag: notificationTag,
			data: { clickUrl, swVersion: SW_VERSION, ...data },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const clickUrl = (event.notification.data && event.notification.data.clickUrl) || "/";

	event.waitUntil(
		(async () => {
			let allClients = [];
			try {
				allClients = await self.clients.matchAll({
					type: "window",
					includeUncontrolled: true,
				});
			} catch (err) {
				console.warn("[sw] failed to inspect existing windows", err);
			}
			// Focus + navigate an existing same-origin window if one is open.
			for (const client of allClients) {
				if (client.url.startsWith(self.location.origin) && "focus" in client) {
					try {
						await client.focus();
					} catch (err) {
						console.warn("[sw] failed to focus existing window", err);
						continue;
					}
					if (typeof client.navigate === "function") {
						try {
							const navigatedClient = await client.navigate(clickUrl);
							if (navigatedClient) return;
						} catch (err) {
							console.warn("[sw] failed to navigate existing window", err);
						}
					}
					break;
				}
			}
			// Otherwise open a fresh window at the deep link.
			if (self.clients.openWindow) await self.clients.openWindow(clickUrl);
		})(),
	);
});
