// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";

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
import { renderWithProviders } from "./test-utils";

function LocationReporter() {
	const loc = useLocation();
	return <div data-testid="location">{loc.pathname}</div>;
}

function renderShell(initialEntries: string[] = ["/mailbox/m1/dashboard"]) {
	return renderWithProviders(
		<Routes>
			<Route
				path="/mailbox/:mailboxId/*"
				element={
					<Shell>
						<LocationReporter />
					</Shell>
				}
			/>
		</Routes>,
		{ initialEntries },
	);
}

describe("Shell mobile drawer", () => {
	it("hamburger button is rendered with aria-expanded=false initially", () => {
		renderShell();
		const button = screen.getByRole("button", { name: /open menu/i });
		expect(button).toBeInTheDocument();
		expect(button).toHaveAttribute("aria-expanded", "false");
		// No drawer in the DOM until opened.
		expect(screen.queryByRole("dialog", { name: /primary navigation/i })).toBeNull();
	});

	it("clicking the hamburger opens a drawer with nav links", async () => {
		const user = userEvent.setup();
		renderShell();
		const button = screen.getByRole("button", { name: /open menu/i });
		await user.click(button);

		const drawer = await screen.findByRole("dialog", { name: /primary navigation/i });
		expect(drawer).toBeInTheDocument();
		expect(button).toHaveAttribute("aria-expanded", "true");

		// Drawer contains the same nav items as the desktop sidebar.
		const drawerLinks = within(drawer).getAllByRole("link");
		const labels = drawerLinks.map((l) => l.textContent?.trim().toLowerCase() ?? "");
		expect(labels.some((l) => l.includes("dashboard"))).toBe(true);
		expect(labels.some((l) => l.includes("cases"))).toBe(true);
		expect(labels.some((l) => l.includes("mail"))).toBe(true);
		expect(labels.some((l) => l.includes("hub"))).toBe(true);
		expect(labels.some((l) => l.includes("settings"))).toBe(true);
	});

	it("tapping a nav item inside the drawer closes the drawer and navigates", async () => {
		const user = userEvent.setup();
		renderShell(["/mailbox/m1/dashboard"]);
		await user.click(screen.getByRole("button", { name: /open menu/i }));
		const drawer = await screen.findByRole("dialog", { name: /primary navigation/i });

		const casesLink = within(drawer).getByRole("link", { name: /cases/i });
		await user.click(casesLink);

		// Route changed.
		expect(screen.getByTestId("location")).toHaveTextContent("/mailbox/m1/cases");
		// Drawer is gone.
		expect(screen.queryByRole("dialog", { name: /primary navigation/i })).toBeNull();
		expect(screen.getByRole("button", { name: /open menu/i })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});

	it("Escape closes the drawer", async () => {
		const user = userEvent.setup();
		renderShell();
		await user.click(screen.getByRole("button", { name: /open menu/i }));
		await screen.findByRole("dialog", { name: /primary navigation/i });

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: /primary navigation/i })).toBeNull();
	});

	it("clicking the backdrop closes the drawer", async () => {
		const user = userEvent.setup();
		renderShell();
		await user.click(screen.getByRole("button", { name: /open menu/i }));
		await screen.findByRole("dialog", { name: /primary navigation/i });

		const backdrop = screen.getByTestId("mobile-drawer-backdrop");
		await user.click(backdrop);
		expect(screen.queryByRole("dialog", { name: /primary navigation/i })).toBeNull();
	});
});
