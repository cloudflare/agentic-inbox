// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePushSetupState } from "../push-setup-state.ts";

const ready = {
	mounted: true,
	configLoading: false,
	hasQueryError: false,
	hasVapidKey: true,
	installed: true,
	pushSupported: true,
	attemptDenied: false,
} satisfies Parameters<typeof derivePushSetupState>[0];

test("push setup waits for hydration and deploy configuration", () => {
	assert.equal(derivePushSetupState({ ...ready, mounted: false }), "loading");
	assert.equal(derivePushSetupState({ ...ready, configLoading: true }), "loading");
	assert.equal(derivePushSetupState({ ...ready, hasQueryError: true }), "error");
	assert.equal(
		derivePushSetupState({ ...ready, hasVapidKey: false }),
		"not_configured",
	);
});

test("push setup requires installation before it offers notification permission", () => {
	assert.equal(derivePushSetupState({ ...ready, installed: false }), "install");
	assert.equal(derivePushSetupState(ready), "enable");
});

test("push setup explains blocked and unsupported installed states", () => {
	assert.equal(derivePushSetupState({ ...ready, attemptDenied: true }), "blocked");
	assert.equal(derivePushSetupState({ ...ready, pushSupported: false }), "unsupported");
	// An unsupported install can never have been refused; say so honestly.
	assert.equal(
		derivePushSetupState({ ...ready, pushSupported: false, attemptDenied: true }),
		"unsupported",
	);
});

test("push setup offers enable until the device actually refuses", () => {
	// iOS reports Notification.permission === "denied" for a Home Screen web app
	// it has never prompted for. Deriving "blocked" from that read hid the Enable
	// button, so requestPermission() never ran and the app stayed blocked for
	// good. Only a refused attempt may block.
	assert.equal(derivePushSetupState(ready), "enable");
	assert.equal(derivePushSetupState({ ...ready, attemptDenied: false }), "enable");
});
