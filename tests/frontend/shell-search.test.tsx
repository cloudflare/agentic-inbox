// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { screen } from "@testing-library/react";
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

import Shell from "~/components/phishsoc/Shell";
import { renderWithProviders } from "./test-utils";

function LocationReporter() {
	const loc = useLocation();
	return (
		<div data-testid="location">
			{loc.pathname}
			{loc.search}
		</div>
	);
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

describe("Shell search", () => {
	it("typing + Enter navigates to /mailbox/:id/search?q=…", async () => {
		const user = userEvent.setup();
		renderShell();
		const input = screen.getByRole("searchbox", { name: /search/i });
		await user.click(input);
		await user.keyboard("invoice");
		await user.keyboard("{Enter}");
		expect(screen.getByTestId("location")).toHaveTextContent(
			"/mailbox/m1/search?q=invoice",
		);
	});

	it("URL-encodes special characters in the query", async () => {
		const user = userEvent.setup();
		renderShell();
		const input = screen.getByRole("searchbox", { name: /search/i });
		await user.click(input);
		await user.type(input, "from:bob & jane");
		await user.keyboard("{Enter}");
		const location = screen.getByTestId("location").textContent ?? "";
		// `&` must be percent-encoded so the rest of the query string isn't lost.
		expect(location).toContain("/mailbox/m1/search?q=");
		expect(location).toContain("%26");
		expect(location).toContain("from%3Abob");
	});

	it("Enter on an empty input does not navigate", async () => {
		const user = userEvent.setup();
		renderShell();
		const input = screen.getByRole("searchbox", { name: /search/i });
		await user.click(input);
		await user.keyboard("{Enter}");
		expect(screen.getByTestId("location")).toHaveTextContent(
			"/mailbox/m1/dashboard",
		);
	});

	it("Cmd+K from anywhere focuses the search input", async () => {
		const user = userEvent.setup();
		renderShell();
		const input = screen.getByRole("searchbox", { name: /search/i });
		expect(document.activeElement).not.toBe(input);
		await user.keyboard("{Meta>}k{/Meta}");
		expect(document.activeElement).toBe(input);
	});

	it("Ctrl+K from anywhere focuses the search input", async () => {
		const user = userEvent.setup();
		renderShell();
		const input = screen.getByRole("searchbox", { name: /search/i });
		expect(document.activeElement).not.toBe(input);
		await user.keyboard("{Control>}k{/Control}");
		expect(document.activeElement).toBe(input);
	});

	it("placeholder copy doesn't promise more than the backend supports", () => {
		renderShell();
		const input = screen.getByRole("searchbox", { name: /search/i });
		const placeholder = input.getAttribute("placeholder") ?? "";
		// Backend only searches emails; should not promise indicators or cases.
		expect(placeholder).not.toMatch(/indicator/i);
		expect(placeholder).not.toMatch(/case/i);
		expect(placeholder).toMatch(/email|message|search/i);
	});
});
