// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import type { Email } from "~/types";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export interface ComposeOptions {
	mode: ComposeMode;
	originalEmail?: Email | null;
	/** When editing a draft, this holds the draft email to pre-fill the composer */
	draftEmail?: Email | null;
}

export type Theme = "light" | "dark";
export type AccentName = "Rust" | "Sage" | "Slate" | "Plum" | "Ink";

export const ACCENT_PRESETS: Array<{ name: AccentName; hue: number }> = [
	{ name: "Rust", hue: 35 },
	{ name: "Sage", hue: 145 },
	{ name: "Slate", hue: 230 },
	{ name: "Plum", hue: 320 },
	{ name: "Ink", hue: 260 },
];

const STORAGE_KEY = "phishsoc-ui";

interface PersistedPrefs {
	theme: Theme;
	hue: number;
	accentName: AccentName;
}

function loadPrefs(): PersistedPrefs {
	if (typeof window === "undefined") {
		return { theme: "dark", hue: 35, accentName: "Rust" };
	}
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<PersistedPrefs>;
			return {
				theme: parsed.theme === "light" ? "light" : "dark",
				hue: typeof parsed.hue === "number" ? parsed.hue : 35,
				accentName: (parsed.accentName as AccentName) ?? "Rust",
			};
		}
	} catch {
		/* ignore */
	}
	return { theme: "dark", hue: 35, accentName: "Rust" };
}

function savePrefs(prefs: PersistedPrefs) {
	if (typeof window === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		/* ignore quota / private mode */
	}
}

interface UIState {
	// Side panel state
	selectedEmailId: string | null;
	isComposing: boolean;
	_previousEmailId: string | null;
	selectEmail: (id: string | null) => void;
	startCompose: (options?: ComposeOptions) => void;
	closePanel: () => void;
	closeCompose: () => void;

	// Compose options
	composeOptions: ComposeOptions;

	// Mobile sidebar
	isSidebarOpen: boolean;
	openSidebar: () => void;
	closeSidebar: () => void;
	toggleSidebar: () => void;

	// Agent panel
	isAgentPanelOpen: boolean;
	openAgentPanel: () => void;
	closeAgentPanel: () => void;
	toggleAgentPanel: () => void;

	// Legacy dialog support (kept for non-split views)
	isComposeModalOpen: boolean;
	openComposeModal: (options?: ComposeOptions) => void;
	closeComposeModal: () => void;

	// Theme + brand-hue (PhishSOC). SSR uses the safe defaults; the boot
	// script in /theme-boot.js applies persisted prefs to <html> before
	// hydration, and a top-level effect in root.tsx hydrates the store from
	// localStorage after mount so toggles persist.
	theme: Theme;
	hue: number;
	accentName: AccentName;
	setTheme: (theme: Theme) => void;
	toggleTheme: () => void;
	setAccent: (name: AccentName) => void;
	hydratePrefsFromStorage: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
	selectedEmailId: null,
	isComposing: false,
	_previousEmailId: null,
	composeOptions: { mode: "new", originalEmail: null },
	isComposeModalOpen: false,
	isSidebarOpen: false,
	// Closed by default. After #82 the panel is reachable on narrow viewports
	// via a slide-over; auto-popping that on every page load would be hostile.
	// Users summon the panel via the topbar "Ask co-pilot" toggle.
	isAgentPanelOpen: false,

	theme: "dark",
	hue: 35,
	accentName: "Rust",

	selectEmail: (id) => set({ selectedEmailId: id, isComposing: false }),

	startCompose: (options) =>
		set((state) => {
			const mode = options?.mode || "new";
			const isReplyOrForward = mode === "reply" || mode === "reply-all" || mode === "forward";
			return {
				isComposing: true,
				_previousEmailId: state.selectedEmailId,
				// Keep selectedEmailId when replying/forwarding so the thread stays visible
				selectedEmailId: isReplyOrForward ? state.selectedEmailId : null,
				composeOptions: options || { mode: "new", originalEmail: null },
				isSidebarOpen: false,
			};
		}),

	closePanel: () => set({ selectedEmailId: null, isComposing: false, _previousEmailId: null, composeOptions: { mode: "new" as const, originalEmail: null } }),

	closeCompose: () =>
		set((state) => ({
			isComposing: false,
			selectedEmailId: state._previousEmailId,
			_previousEmailId: null,
			composeOptions: { mode: "new" as const, originalEmail: null },
		})),

	openSidebar: () => set({ isSidebarOpen: true }),
	closeSidebar: () => set({ isSidebarOpen: false }),
	toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),

	openAgentPanel: () => set({ isAgentPanelOpen: true }),
	closeAgentPanel: () => set({ isAgentPanelOpen: false }),
	toggleAgentPanel: () => set({ isAgentPanelOpen: !get().isAgentPanelOpen }),

	openComposeModal: (options) =>
		set({
			composeOptions: options || { mode: "new", originalEmail: null },
			isComposeModalOpen: true,
		}),

	closeComposeModal: () =>
		set({
			isComposeModalOpen: false,
			composeOptions: { mode: "new", originalEmail: null },
		}),

	setTheme: (theme) => {
		const next = { ...pickPrefs(get()), theme };
		savePrefs(next);
		set({ theme });
	},
	toggleTheme: () => {
		const theme: Theme = get().theme === "dark" ? "light" : "dark";
		const next = { ...pickPrefs(get()), theme };
		savePrefs(next);
		set({ theme });
	},
	setAccent: (name) => {
		const preset = ACCENT_PRESETS.find((p) => p.name === name) ?? ACCENT_PRESETS[0];
		const next = { ...pickPrefs(get()), accentName: preset.name, hue: preset.hue };
		savePrefs(next);
		set({ accentName: preset.name, hue: preset.hue });
	},
	hydratePrefsFromStorage: () => {
		const prefs = loadPrefs();
		set(prefs);
	},
}));

function pickPrefs(s: UIState): PersistedPrefs {
	return { theme: s.theme, hue: s.hue, accentName: s.accentName };
}
