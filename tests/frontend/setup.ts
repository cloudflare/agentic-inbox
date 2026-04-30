// Loaded by vitest (`setupFiles`) for the frontend project. Adds jest-dom's
// custom matchers (`toBeInTheDocument`, `toHaveTextContent`, …) and runs RTL's
// cleanup after each test so portals (toasts, tooltips) don't leak between tests.

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom doesn't ship `matchMedia`. The agent-panel layout uses it to branch
// between in-flow column (xl+) and slide-over (<xl), so a stub is needed.
// Tests can override `window.matchMedia` per-case to flip branches.
if (typeof window !== "undefined" && !window.matchMedia) {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
}

afterEach(() => {
	cleanup();
});
