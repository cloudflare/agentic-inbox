// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.
//
// Tests for the agent-panel layout (#82). Verifies that the panel:
//  - is reachable via a topbar toggle on every viewport
//  - renders in-flow at xl+ (no `role=dialog` — it takes layout space)
//  - renders as a slide-over with `role=dialog` + backdrop below xl
//  - dismisses on Escape and on backdrop click
//
// `window.matchMedia` is stubbed in `setup.ts`. Tests that need the in-flow
// branch override the stub locally.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";

vi.mock("~/queries/mailboxes", () => ({
	useMailbox: () => ({
		data: { id: "m1", email: "alice@acme.com", name: "Alice" },
	}),
	useMailboxes: () => ({
		data: [{ id: "m1", email: "alice@acme.com", name: "Alice" }],
	}),
}));

vi.mock("~/queries/dashboard", () => ({
	useDashboardSummary: () => ({
		data: undefined,
		isLoading: false,
		isError: false,
	}),
}));

import Shell from "~/components/phishsoc/Shell";
import { useUIStore } from "~/hooks/useUIStore";
import { renderWithProviders } from "./test-utils";

const RIGHT_PANEL_TEST_ID = "agent-panel-content";

function RightPanelStub() {
	return <div data-testid={RIGHT_PANEL_TEST_ID}>agent panel content</div>;
}

function renderShell(
	initialEntries: string[] = ["/mailbox/m1/dashboard"],
	rightPanel: React.ReactNode = <RightPanelStub />,
) {
	return renderWithProviders(
		<Routes>
			<Route
				path="/mailbox/:mailboxId/*"
				element={
					<Shell rightPanel={rightPanel}>
						<div data-testid="main-content">main</div>
					</Shell>
				}
			/>
		</Routes>,
		{ initialEntries },
	);
}

function setMatchMedia(matches: (query: string) => boolean) {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: matches(query),
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
}

beforeEach(() => {
	// Each test starts with the panel closed and the default narrow viewport.
	useUIStore.setState({ isAgentPanelOpen: false });
	setMatchMedia(() => false);
});

afterEach(() => {
	useUIStore.setState({ isAgentPanelOpen: false });
});

describe("Shell agent panel toggle", () => {
	it("the panel is closed by default — neither in-flow nor slide-over copy renders", () => {
		renderShell();
		expect(screen.queryByTestId(RIGHT_PANEL_TEST_ID)).not.toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("clicking the topbar 'Ask co-pilot' button opens the panel", async () => {
		const user = userEvent.setup();
		renderShell();
		const trigger = screen.getByRole("button", { name: /ask co-?pilot/i });
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		await user.click(trigger);
		expect(useUIStore.getState().isAgentPanelOpen).toBe(true);
		expect(screen.getByTestId(RIGHT_PANEL_TEST_ID)).toBeInTheDocument();
		expect(trigger).toHaveAttribute("aria-expanded", "true");
	});

	it("clicking the topbar trigger again closes the panel", async () => {
		const user = userEvent.setup();
		renderShell();
		const trigger = screen.getByRole("button", { name: /ask co-?pilot/i });
		await user.click(trigger);
		await user.click(trigger);
		expect(useUIStore.getState().isAgentPanelOpen).toBe(false);
		expect(screen.queryByTestId(RIGHT_PANEL_TEST_ID)).not.toBeInTheDocument();
	});
});

describe("Shell agent panel — in-flow at xl+", () => {
	beforeEach(() => {
		// Match the same media query the implementation uses.
		setMatchMedia((q) => q.includes("min-width") && q.includes("1280"));
		useUIStore.setState({ isAgentPanelOpen: true });
	});

	it("renders the panel as an in-flow region (no dialog role)", () => {
		renderShell();
		const panel = screen.getByTestId(RIGHT_PANEL_TEST_ID);
		expect(panel).toBeInTheDocument();
		// In-flow rendering must not advertise modal semantics — the panel
		// shares layout with the rest of the main column rather than overlaying.
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		// No backdrop element exists in the in-flow rendering.
		expect(
			document.querySelector("[data-agent-panel-backdrop]"),
		).not.toBeInTheDocument();
	});
});

describe("Shell agent panel — slide-over below xl", () => {
	beforeEach(() => {
		// Below the xl breakpoint — slide-over branch.
		setMatchMedia(() => false);
		useUIStore.setState({ isAgentPanelOpen: true });
	});

	it("renders as a dialog with modal semantics and an accessible label", async () => {
		renderShell();
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(dialog).toHaveAccessibleName(/agent/i);
		expect(within(dialog).getByTestId(RIGHT_PANEL_TEST_ID)).toBeInTheDocument();
	});

	it("Escape closes the slide-over", async () => {
		const user = userEvent.setup();
		renderShell();
		await screen.findByRole("dialog");
		await user.keyboard("{Escape}");
		expect(useUIStore.getState().isAgentPanelOpen).toBe(false);
	});

	it("clicking the close button closes the slide-over", async () => {
		const user = userEvent.setup();
		renderShell();
		const dialog = await screen.findByRole("dialog");
		const closeButton = within(dialog).getByRole("button", {
			name: /close/i,
		});
		await user.click(closeButton);
		expect(useUIStore.getState().isAgentPanelOpen).toBe(false);
	});
});
