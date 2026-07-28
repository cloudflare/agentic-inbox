// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type PushSetupState =
	| "loading"
	| "error"
	| "not_configured"
	| "install"
	| "blocked"
	| "unsupported"
	| "enable";

type PushSetupInput = {
	mounted: boolean;
	configLoading: boolean;
	hasQueryError: boolean;
	hasVapidKey: boolean;
	installed: boolean;
	pushSupported: boolean;
	/** An enable attempt that the device actually refused (NotAllowedError). */
	attemptDenied: boolean;
};

export function derivePushSetupState(input: PushSetupInput): PushSetupState {
	if (!input.mounted || input.configLoading) return "loading";
	if (input.hasQueryError) return "error";
	if (!input.hasVapidKey) return "not_configured";
	if (!input.installed) return "install";
	if (!input.pushSupported) return "unsupported";
	// "blocked" is never derived from Notification.permission. iOS reports a
	// stale "denied" for a Home Screen web app it has never prompted for, and
	// gating the Enable button on that read hides the only path that can ever
	// change it — the app then looks blocked forever while iOS was never asked.
	// Only an attempt the device refused sets this.
	if (input.attemptDenied) return "blocked";
	return "enable";
}
