// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import type { DashboardSummary } from "~/types";

const refetch = vi.fn();
let queryState: {
	data: DashboardSummary | undefined;
	isLoading: boolean;
	isError: boolean;
};

vi.mock("~/queries/dashboard", () => ({
	useDashboardSummary: () => ({ ...queryState, refetch }),
}));

import DashboardRoute from "~/routes/dashboard";
import { renderWithProviders } from "./test-utils";

function renderDashboard() {
	return renderWithProviders(
		<Routes>
			<Route path="/mailbox/:mailboxId/dashboard" element={<DashboardRoute />} />
		</Routes>,
		{ initialEntries: ["/mailbox/m1/dashboard"] },
	);
}

const populated: DashboardSummary = {
	now: "2026-04-29T12:00:00Z",
	threatsBlocked: 3,
	openCases: 7,
	hubContributions: 2,
	pipelineSuccess: 0.92,
	threatPressure: [0, 1, 0, 2, 1, 0, 3, 0, 0, 1, 0, 0],
	recentCases: [
		{ id: "c1", title: "Suspicious wire request", status: "open", updated_at: "2026-04-29T11:00:00Z" },
		{ id: "c2", title: "Credential phish", status: "closed-tp", updated_at: "2026-04-29T08:00:00Z" },
	],
};

describe("DashboardRoute", () => {
	beforeEach(() => {
		refetch.mockReset();
	});

	it("renders the loader while the query is pending", () => {
		queryState = { data: undefined, isLoading: true, isError: false };
		renderDashboard();
		// The kumo Loader doesn't expose role=progressbar reliably, so assert by
		// the presence of the header copy + absence of the KPI labels.
		expect(screen.getByText(/good morning/i)).toBeInTheDocument();
		expect(screen.queryByText(/threats blocked · 24h/i)).not.toBeInTheDocument();
	});

	it("renders error UI with a working retry when the query fails", async () => {
		queryState = { data: undefined, isLoading: false, isError: true };
		renderDashboard();
		expect(screen.getByText(/couldn't load the dashboard/i)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /retry/i }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("renders KPI values and recent cases when data is present", () => {
		queryState = { data: populated, isLoading: false, isError: false };
		renderDashboard();
		expect(screen.getByText(/threats blocked · 24h/i)).toBeInTheDocument();
		expect(screen.getByText("3")).toBeInTheDocument();
		expect(screen.getByText("7")).toBeInTheDocument();
		expect(screen.getByText("92%")).toBeInTheDocument();
		expect(screen.getByText("2")).toBeInTheDocument();
		expect(screen.getByText(/suspicious wire request/i)).toBeInTheDocument();
		expect(screen.getByText(/credential phish/i)).toBeInTheDocument();
	});

	it("renders '—' for pipelineSuccess when no scans have run, and 'No cases yet.' when empty", () => {
		queryState = {
			data: {
				now: populated.now,
				threatsBlocked: 0,
				openCases: 0,
				hubContributions: 0,
				pipelineSuccess: null,
				threatPressure: new Array(12).fill(0),
				recentCases: [],
			},
			isLoading: false,
			isError: false,
		};
		renderDashboard();
		expect(screen.getByText("—")).toBeInTheDocument();
		expect(screen.getByText(/no cases yet/i)).toBeInTheDocument();
	});

	it("links each recent case to /mailbox/:id/cases/:caseId", () => {
		queryState = { data: populated, isLoading: false, isError: false };
		renderDashboard();
		const link = screen.getByRole("link", { name: /suspicious wire request/i });
		expect(link).toHaveAttribute("href", "/mailbox/m1/cases/c1");
	});
});
