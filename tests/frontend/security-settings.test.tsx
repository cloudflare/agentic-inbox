// Coverage for the new attachment-policy + folder-policy controls in
// `app/components/SecuritySettingsPanel.tsx`. Drives them through the full
// settings save flow so we verify the merged settings payload that hits the
// PUT route, not just the local component state.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import type { Mailbox, MailboxSettings, SecuritySettings } from "~/types";

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

function makeMailbox(security: SecuritySettings = { enabled: true }): Mailbox {
	return {
		id: "m1",
		email: "ops@example.com",
		name: "Ops",
		settings: {
			autoDraft: { enabled: true },
			agentModel: "@cf/moonshotai/kimi-k2.5",
			security,
		} as MailboxSettings,
	} as unknown as Mailbox;
}

async function lastSavedSettings(): Promise<MailboxSettings> {
	await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
	const payload = mutateAsync.mock.calls[0][0] as {
		mailboxId: string;
		settings: MailboxSettings;
	};
	return payload.settings;
}

describe("SecuritySettingsPanel · attachment + folder controls", () => {
	beforeEach(() => {
		mutateAsync.mockReset();
		mutateAsync.mockResolvedValue(undefined);
	});

	it("persists a changed executable_action through the save mutation", async () => {
		const user = userEvent.setup();
		mailboxFixture = makeMailbox({ enabled: true });
		renderSettings();

		// Open the collapsible attachment-filtering section.
		await user.click(await screen.findByText(/attachment filtering/i));

		const group = await screen.findByRole("radiogroup", { name: /executable files/i });
		await user.click(within(group).getByRole("radio", { name: /score/i }));

		await user.click(screen.getByRole("button", { name: /save changes/i }));

		const saved = await lastSavedSettings();
		expect(saved.security?.attachment_policy?.executable_action).toBe("score");
	});

	it("persists a custom blocklist extension list", async () => {
		const user = userEvent.setup();
		mailboxFixture = makeMailbox({ enabled: true });
		renderSettings();

		await user.click(await screen.findByText(/attachment filtering/i));

		const input = await screen.findByLabelText(/custom blocklist/i);
		await user.clear(input);
		// Paste rather than type: the input is controlled and re-parses on
		// every keystroke (joining with ", "), which collapses partial typed
		// entries before the next comma is reached. Pasting is also closer
		// to the real-world flow operators use to populate this field.
		await user.click(input);
		await user.paste("dmg, .rtf, ACE");

		await user.click(screen.getByRole("button", { name: /save changes/i }));

		const saved = await lastSavedSettings();
		// Lowercased + leading-dot stripped (matches the consumer's
		// normalisation in workers/security/settings.ts so the round-trip is
		// idempotent).
		expect(saved.security?.attachment_policy?.custom_blocklist_extensions).toEqual([
			"dmg",
			"rtf",
			"ace",
		]);
	});

	it("persists a folder skip_classifier toggle", async () => {
		const user = userEvent.setup();
		mailboxFixture = makeMailbox({ enabled: true });
		renderSettings();

		await user.click(await screen.findByText(/folder rules/i));

		const archiveSkipClassifier = await screen.findByTestId("skip-classifier-archive");
		await user.click(archiveSkipClassifier);

		await user.click(screen.getByRole("button", { name: /save changes/i }));

		const saved = await lastSavedSettings();
		expect(saved.security?.folder_policies?.archive?.mode).toBe("skip_classifier");
	});

	it("persists a treat_as_verified toggle for a folder", async () => {
		const user = userEvent.setup();
		mailboxFixture = makeMailbox({ enabled: true });
		renderSettings();

		await user.click(await screen.findByText(/folder rules/i));

		const inboxVerified = await screen.findByTestId("treat-verified-inbox");
		await user.click(inboxVerified);

		await user.click(screen.getByRole("button", { name: /save changes/i }));

		const saved = await lastSavedSettings();
		expect(saved.security?.folder_policies?.inbox?.treat_as_verified).toBe(true);
	});
});
