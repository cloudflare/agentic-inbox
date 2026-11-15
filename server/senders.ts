import { HTTPException } from "hono/http-exception";
import type { Database } from "./db";
import { mailboxConfig } from "./mailboxes";
import {
	canUseSender,
	resolveSenderId,
	type SenderAccess,
	type SenderConfiguration,
	type SenderContext,
	type SenderIdentity,
} from "../shared/senders";

export class SenderStore {
	constructor(readonly db: Database) {}
	async configuration(): Promise<SenderConfiguration> {
		const senders = await this.db<
			SenderIdentity[]
		>`SELECT s.*,COALESCE(s.name,m.settings->>'fromName',m.name,s.email) AS name,m.settings
   FROM sender_identities s LEFT JOIN mailboxes m ON m.id=s.mailbox_id WHERE s.archived_at IS NULL ORDER BY s.email`;
		const [settings] = await this.db<
			{ default_sender_identity_id: string | null }[]
		>`SELECT default_sender_identity_id FROM inbox_settings WHERE id`;
		return {
			senders,
			default_sender_identity_id: settings?.default_sender_identity_id ?? null,
		};
	}
	async save(
		input: { email: string; name: string; mailbox_id: string },
		options: { live?: boolean; mailboxIds?: string[] },
		id?: string,
	) {
		return this.db.begin(async (tx) => {
			await tx`SELECT id FROM inbox_settings WHERE id FOR UPDATE`;
			if (id) {
				const [existing] =
					await tx`SELECT * FROM sender_identities WHERE id=${id} AND archived_at IS NULL`;
				if (!existing)
					throw new HTTPException(404, { message: "Sender not found" });
				if (
					options.mailboxIds &&
					!options.mailboxIds.includes(existing.mailbox_id)
				)
					throw new HTTPException(403, {
						message: "API key does not permit this sender's mailbox",
					});
			}
			if (options.mailboxIds && !options.mailboxIds.includes(input.mailbox_id))
				throw new HTTPException(403, {
					message: "API key does not permit this sender's mailbox",
				});
			const [mailbox] =
				await tx`SELECT id FROM mailboxes WHERE id=${input.mailbox_id}`;
			if (!mailbox)
				throw new HTTPException(400, {
					message: "Choose an existing sending mailbox",
				});
			if (
				options.live &&
				(await mailboxConfig(this.db, input.mailbox_id))?.from !== input.email
			)
				throw new HTTPException(400, {
					message:
						"Live senders must use the approved public address of their ingest mailbox",
				});
			const [duplicate] =
				await tx`SELECT id FROM sender_identities WHERE lower(email)=${input.email} AND archived_at IS NULL AND id<>${id ?? ""}`;
			if (duplicate)
				throw new HTTPException(409, {
					message: "This sender email is already configured",
				});
			const [sender] = id
				? await tx`UPDATE sender_identities SET email=${input.email},name=${input.name},mailbox_id=${input.mailbox_id} WHERE id=${id} RETURNING *`
				: await tx`INSERT INTO sender_identities (id,email,name,mailbox_id) VALUES (${crypto.randomUUID()},${input.email},${input.name},${input.mailbox_id}) RETURNING *`;
			return sender;
		});
	}
	async remove(id: string, mailboxIds?: string[]) {
		await this.db.begin(async (tx) => {
			const [settings] =
				await tx`SELECT default_sender_identity_id FROM inbox_settings WHERE id FOR UPDATE`;
			const [sender] =
				await tx`SELECT * FROM sender_identities WHERE id=${id} AND archived_at IS NULL`;
			if (!sender)
				throw new HTTPException(404, { message: "Sender not found" });
			if (mailboxIds && !mailboxIds.includes(sender.mailbox_id))
				throw new HTTPException(403, {
					message: "API key does not permit this sender's mailbox",
				});
			if (settings?.default_sender_identity_id === id)
				throw new HTTPException(409, {
					message: "Choose another default sender before removing this one",
				});
			await tx`UPDATE sender_identities SET active=false,archived_at=now() WHERE id=${id}`;
		});
	}

	async resolve(
		context: SenderContext,
		options: { live?: boolean } & SenderAccess = {},
	) {
		const config = await this.configuration();
		// A key's own default replaces the workspace default; it never falls back.
		if (options.mailboxIds && options.defaultSenderId)
			config.default_sender_identity_id = options.defaultSenderId;
		const id = resolveSenderId(config, context);
		const sender = config.senders.find((s) => s.id === id);
		if (!sender || !sender.active || !sender.mailbox_id)
			throw new HTTPException(409, {
				message:
					"Choose an available sender; the default or matching sender is missing, unavailable, or ambiguous.",
			});
		if (!canUseSender(sender, options))
			throw new HTTPException(403, {
				message: "API key does not permit this sender",
			});
		if (
			options.live &&
			(await mailboxConfig(this.db, sender.mailbox_id))?.from !== sender.email
		)
			throw new HTTPException(403, {
				message: "Sender is not enabled for live sending",
			});
		return sender;
	}
	async setDefault(
		id: string,
		options: { live?: boolean; mailboxIds?: string[] } = {},
	) {
		await this.db.begin(async (tx) => {
			await tx`SELECT id FROM inbox_settings WHERE id FOR UPDATE`;
			await this.resolve({ explicit: id, mailboxId: "" }, options);
			await tx`UPDATE inbox_settings SET default_sender_identity_id=${id} WHERE id`;
		});
		return this.configuration();
	}
}
