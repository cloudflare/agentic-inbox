import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";
import { SenderStore } from "../../server/senders";

test("an administrator selects a key's sender identities and default", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		senders = new SenderStore(db);
	const tag = crypto.randomUUID().slice(0, 8);
	const box = `key-senders-${tag}@example.test`,
		other = `key-other-${tag}@example.test`;
	const email = `outside-${tag}@example.test`,
		name = `Key senders ${tag}`;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await store.createMailbox(box, "Key senders");
		await store.createMailbox(other, "Key other");
		const sender = await senders.save(
			{ email, name: "Outside", mailbox_id: other },
			{},
		);
		await page.goto(`/mailbox/${box}/settings?tab=api-keys`);
		await page.getByRole("button", { name: "Create key", exact: true }).click();
		await page.getByLabel("Name").fill(name);
		await page
			.getByRole("button", { name: "Create key", exact: true })
			.last()
			.click();
		await page.getByRole("button", { name: "Done", exact: true }).click();
		const row = page.getByRole("listitem").filter({ hasText: name });
		await expect(row).not.toContainText(email);
		await row.getByRole("button", { name: "Senders", exact: true }).click();
		const makeDefault = row.getByRole("radio", {
			name: `Make ${email} the default`,
		});
		await expect(makeDefault).toBeDisabled();
		await row.getByRole("checkbox", { name: `Allow ${email}` }).check();
		await makeDefault.check();
		await row.getByRole("button", { name: "Save senders" }).click();
		await expect(row).toContainText(`${email} (default)`);
		const [key] =
			await db`SELECT to_json(sender_identity_ids) AS ids,default_sender_identity_id FROM inbox_api_keys WHERE name=${name}`;
		expect(key.ids).toEqual([sender.id]);
		expect(key.default_sender_identity_id).toBe(sender.id);
		expect(errors).toEqual([]);
	} finally {
		await db`DELETE FROM inbox_api_keys WHERE name=${name}`;
		await db`DELETE FROM sender_identities WHERE email=${email}`;
		await db`DELETE FROM mailboxes WHERE id IN ${db([box, other])}`;
		await db.end();
	}
});
