// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";
import type { DashboardSummary } from "~/types";

vi.mock("~/queries/mailboxes", () => ({
	useMailbox: () => ({
		data: { id: "m1", email: "alice@acme.com", name: "Alice" },
	}),
	useMailboxes: () => ({
		data: [{ id: "m1", email: "alice@acme.com", name: "Alice" }],
	}),
}));

let queryState: {
	data: DashboardSummary | undefined;
	isLoading: boolean;
	isError: boolean;
};

vi.mock("~/queries/dashboard", () => ({
	useDashboardSummary: () => queryState,
}));

import Shell from "~/components/phishsoc/Shell";
import { renderWithProviders } from "./test-utils";

function makeSummary(pipelineSuccess: number | null): DashboardSummary {
	return {
		now: "2026-04-30T12:00:00Z",
		threatsBlocked: 0,
		openCases: 0,
		hubContributions: 0,
		pipelineSuccess,
		threatPressure: [],
		recentCases: [],
	};
}

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

describe("Shell pipeline status pill", () => {
	it("shows a 'Pipeline online' state when pipelineSuccess is high", () => {
		queryState = {
			data: makeSummary(0.98),
			isLoading: false,
			isError: false,
		};
		renderShell();
		const pill = screen.getByRole("status", { name: /pipeline/i });
		expect(pill).toHaveTextContent(/online/i);
		expect(pill).not.toHaveTextContent(/degraded|failing|no data/i);
	});

	it("shows a 'Degraded' state when pipelineSuccess is mid", () => {
		queryState = {
			data: makeSummary(0.7),
			isLoading: false,
			isError: false,
		};
		renderShell();
		const pill = screen.getByRole("status", { name: /pipeline/i });
		expect(pill).toHaveTextContent(/degraded/i);
		expect(pill).not.toHaveTextContent(/online|failing/i);
	});

	it("shows a 'Pipeline failing' state when pipelineSuccess is low", () => {
		queryState = {
			data: makeSummary(0.2),
			isLoading: false,
			isError: false,
		};
		renderShell();
		const pill = screen.getByRole("status", { name: /pipeline/i });
		expect(pill).toHaveTextContent(/failing/i);
		expect(pill).not.toHaveTextContent(/online|degraded/i);
	});

	it("shows a 'No data' state when pipelineSuccess is null", () => {
		queryState = {
			data: makeSummary(null),
			isLoading: false,
			isError: false,
		};
		renderShell();
		const pill = screen.getByRole("status", { name: /pipeline/i });
		expect(pill).toHaveTextContent(/no data/i);
		expect(pill).not.toHaveTextContent(/online|degraded|failing/i);
	});

	it("shows 'No data' while the query is loading (no fake green state)", () => {
		queryState = { data: undefined, isLoading: true, isError: false };
		renderShell();
		const pill = screen.getByRole("status", { name: /pipeline/i });
		expect(pill).not.toHaveTextContent(/online/i);
	});

	it("clicking the pill navigates to the mailbox dashboard", async () => {
		queryState = {
			data: makeSummary(0.98),
			isLoading: false,
			isError: false,
		};
		const user = userEvent.setup();
		// Start somewhere other than /dashboard so we can observe the navigation.
		renderShell(["/mailbox/m1/cases"]);
		expect(screen.getByTestId("location")).toHaveTextContent(
			"/mailbox/m1/cases",
		);
		const pill = screen.getByRole("status", { name: /pipeline/i });
		await user.click(pill);
		expect(screen.getByTestId("location")).toHaveTextContent(
			"/mailbox/m1/dashboard",
		);
	});

	it("does not render a fabricated p50 latency placeholder", () => {
		queryState = {
			data: makeSummary(0.98),
			isLoading: false,
			isError: false,
		};
		renderShell();
		// The old static pill rendered "p50 —" with no real data behind it.
		// Until pipeline-runs-table (#71) lands, the pill should not advertise
		// a latency at all.
		expect(screen.queryByText(/p50/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/p95/i)).not.toBeInTheDocument();
	});
});
