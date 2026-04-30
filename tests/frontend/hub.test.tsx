// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import type {
	HubContributionsResponse,
	HubDestroylistResponse,
	HubSharingGroupsResponse,
} from "~/types";

interface QueryStub<T> {
	data?: T;
	isLoading: boolean;
	isError: boolean;
	refetch: () => void;
}

const refetch = vi.fn();

let contributionsState: QueryStub<HubContributionsResponse>;
let destroylistState: QueryStub<HubDestroylistResponse>;
let sharingGroupsState: QueryStub<HubSharingGroupsResponse>;

vi.mock("~/queries/hub", () => ({
	useHubContributions: () => contributionsState,
	useHubDestroylist: () => destroylistState,
	useHubSharingGroups: () => sharingGroupsState,
}));

import HubRoute from "~/routes/hub";
import { renderWithProviders } from "./test-utils";

function renderHub() {
	return renderWithProviders(
		<Routes>
			<Route path="/mailbox/:mailboxId/hub" element={<HubRoute />} />
		</Routes>,
		{ initialEntries: ["/mailbox/m1/hub"] },
	);
}

function configured<T>(data: T): QueryStub<{ configured: true; data: T }> {
	return {
		data: { configured: true, data },
		isLoading: false,
		isError: false,
		refetch,
	};
}

const unconfigured = (): QueryStub<{ configured: false }> => ({
	data: { configured: false },
	isLoading: false,
	isError: false,
	refetch,
});

describe("HubRoute", () => {
	beforeEach(() => {
		refetch.mockReset();
	});

	it("renders the not-configured hint with a settings link when any panel is unconfigured", () => {
		contributionsState = unconfigured();
		destroylistState = unconfigured();
		sharingGroupsState = unconfigured();
		renderHub();
		expect(screen.getByText(/hub not configured/i)).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /open settings/i }),
		).toHaveAttribute("href", "/mailbox/m1/settings");
		expect(screen.queryByText(/my contributions/i)).not.toBeInTheDocument();
	});

	it("renders all three panels with real data when configured", () => {
		contributionsState = configured([
			{
				uuid: "e1",
				info: "Phish targeting finance",
				date: "2026-04-29",
				timestamp: "1714389600",
				attribute_count: 4,
				sharing_group_uuid: "sg1",
			},
		]);
		destroylistState = configured({
			values: ["bad.example.com", "evil.example.org"],
			count: 2,
		});
		sharingGroupsState = configured({
			groups: [
				{ uuid: "sg1", name: "Trusted retailers", role: "member" },
				{ uuid: "sg2", name: "Healthcare ISAC", description: "shared sigs" },
			],
		});

		renderHub();

		expect(screen.getByText(/my contributions/i)).toBeInTheDocument();
		expect(screen.getByText(/phish targeting finance/i)).toBeInTheDocument();
		expect(screen.getByText(/4 attributes · shared/i)).toBeInTheDocument();

		expect(screen.getByText(/destroylist preview/i)).toBeInTheDocument();
		expect(screen.getByText("bad.example.com")).toBeInTheDocument();
		expect(screen.getByText("evil.example.org")).toBeInTheDocument();
		expect(screen.getByText(/2 indicators/i)).toBeInTheDocument();

		// Match the uppercased panel title exactly so the destroylist
		// footnote ("…across all sharing groups…") doesn't collide.
		expect(screen.getByText(/^sharing groups$/i)).toBeInTheDocument();
		expect(screen.getByText(/trusted retailers/i)).toBeInTheDocument();
		expect(screen.getByText(/healthcare isac/i)).toBeInTheDocument();
	});

	it("shows a per-panel error with a working retry when one panel fails", async () => {
		contributionsState = {
			data: undefined,
			isLoading: false,
			isError: true,
			refetch,
		};
		destroylistState = configured({ values: [], count: 0 });
		sharingGroupsState = configured({ groups: [] });

		renderHub();

		expect(screen.getByText(/couldn't reach the hub/i)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /retry/i }));
		expect(refetch).toHaveBeenCalledTimes(1);

		// Other configured-but-empty panels render their own empty copy.
		expect(screen.getByText(/destroylist is empty/i)).toBeInTheDocument();
		expect(
			screen.getByText(/isn't a member of any sharing groups/i),
		).toBeInTheDocument();
	});

	it("renders the loader while a panel's query is pending", () => {
		contributionsState = {
			data: undefined,
			isLoading: true,
			isError: false,
			refetch,
		};
		destroylistState = configured({ values: [], count: 0 });
		sharingGroupsState = configured({ groups: [] });
		renderHub();
		// Configured panels still render their headers; the loading panel
		// shows neither its empty copy nor any populated rows.
		expect(screen.getByText(/my contributions/i)).toBeInTheDocument();
		expect(
			screen.queryByText(/no contributions yet/i),
		).not.toBeInTheDocument();
	});
});
