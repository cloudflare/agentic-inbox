// Behavior card from `app/routes/settings.tsx` — verifies the auto-draft
// toggle and agent-model picker render the saved settings, persist user
// edits via the update mutation, and surface validation errors via toasts.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import type { Mailbox } from "~/types";

const mutateAsync = vi.fn();
const updateMailboxMock = {
	mutateAsync,
	isPending: false,
} as unknown as ReturnType<typeof import("~/queries/mailboxes").useUpdateMailbox>;

let mailboxFixture: Mailbox;

vi.mock("~/queries/mailboxes", () => ({
	useMailbox: () => ({ data: mailboxFixture }),
	useUpdateMailbox: () => updateMailboxMock,
}));

import SettingsRoute from "~/routes/settings";
import { renderWithProviders } from "./test-utils";

function renderSettings() {
	return renderWithProviders(
		<Routes>
			<Route path="/mailbox/:mailboxId/settings" element={<SettingsRoute />} />
		</Routes>,
		{ initialEntries: ["/mailbox/m1/settings"] },
	);
}

describe("Settings · Behavior card", () => {
	beforeEach(() => {
		mutateAsync.mockReset();
		mutateAsync.mockResolvedValue(undefined);
		mailboxFixture = {
			id: "m1",
			email: "ops@example.com",
			name: "Ops",
			settings: {
				autoDraft: { enabled: true },
				agentModel: "@cf/moonshotai/kimi-k2.5",
			},
		} as unknown as Mailbox;
	});

	it("renders auto-draft toggle reflecting the saved value", async () => {
		renderSettings();
		const toggle = await screen.findByRole("checkbox", { name: /auto-draft replies/i });
		expect(toggle).toBeChecked();
	});

	it("persists auto-draft off and the chosen model on save", async () => {
		const user = userEvent.setup();
		renderSettings();

		const toggle = await screen.findByRole("checkbox", { name: /auto-draft replies/i });
		await user.click(toggle);

		const select = screen.getByLabelText(/agent model/i);
		await user.selectOptions(select, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");

		await user.click(screen.getByRole("button", { name: /save changes/i }));

		await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
		const payload = mutateAsync.mock.calls[0][0] as {
			mailboxId: string;
			settings: { autoDraft: { enabled: boolean }; agentModel: string };
		};
		expect(payload.mailboxId).toBe("m1");
		expect(payload.settings.autoDraft).toEqual({ enabled: false });
		expect(payload.settings.agentModel).toBe(
			"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		);
	});

	it("surfaces an error toast when a custom model is empty", async () => {
		const user = userEvent.setup();
		renderSettings();

		await user.selectOptions(
			await screen.findByLabelText(/agent model/i),
			"__custom__",
		);
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		expect(await screen.findByText(/custom model cannot be empty/i)).toBeInTheDocument();
		expect(mutateAsync).not.toHaveBeenCalled();
	});

	it("surfaces an error toast when a custom model is missing the @cf/ prefix", async () => {
		const user = userEvent.setup();
		renderSettings();

		await user.selectOptions(
			await screen.findByLabelText(/agent model/i),
			"__custom__",
		);
		const customInput = await screen.findByPlaceholderText("@cf/your/model");
		await user.type(customInput, "not-a-cf-model");
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		expect(await screen.findByText(/must start with @cf\//i)).toBeInTheDocument();
		expect(mutateAsync).not.toHaveBeenCalled();
	});
});
