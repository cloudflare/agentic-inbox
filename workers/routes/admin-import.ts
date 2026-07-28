import type { Context } from "hono";
import PostalMime, { type Email } from "postal-mime";
import type { SessionClaims } from "../lib/auth.ts";
import { importParsedEmail } from "../lib/import/import-email.ts";
import {
  mapZohoFolder,
  normalizeZohoFolderPath,
  sha256RawEmail,
} from "../lib/import/parse.ts";
import { mailboxAccess } from "../lib/mailbox-access.ts";
import { MAX_EMAIL_SIZE } from "../lib/store-email.ts";
import type { Env } from "../types.ts";

export type AdminImportRouteContext = {
  Bindings: Env;
  Variables: { session?: SessionClaims };
};

type AdminImportRouteDependencies = {
  canAccessMailbox(
    env: Env,
    userId: string,
    mailboxId: string,
  ): Promise<boolean>;
  mailboxExists(env: Env, mailboxId: string): Promise<boolean>;
  readRawEmail(c: Context<AdminImportRouteContext>): Promise<ArrayBuffer>;
  parseRawEmail(raw: ArrayBuffer): Promise<Email>;
  importEmail(
    env: Env,
    parsed: Email,
    folder: NonNullable<ReturnType<typeof mapZohoFolder>>,
    mailboxId: string,
    rawSha256: string,
  ): ReturnType<typeof importParsedEmail>;
};

const defaultDependencies: AdminImportRouteDependencies = {
  canAccessMailbox: (env, userId, mailboxId) =>
    mailboxAccess(env).canAccessMailbox(userId, mailboxId),
  async mailboxExists(env, mailboxId) {
    return Boolean(await env.BUCKET.head(`mailboxes/${mailboxId}.json`));
  },
  readRawEmail: (c) => c.req.arrayBuffer(),
  parseRawEmail: (raw) => new PostalMime().parse(raw),
  importEmail(env, parsed, folder, mailboxId, rawSha256) {
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
    return importParsedEmail(
      { bucket: env.BUCKET, mailbox: stub },
      parsed,
      folder,
      mailboxId,
      rawSha256,
    );
  },
};

export function createAdminImportRouteHandler(
  overrides: Partial<AdminImportRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (c: Context<AdminImportRouteContext>) => {
    const sourceFolders = c.req.queries("folder");
    if (!sourceFolders || sourceFolders.length !== 1) {
      return c.json(
        { error: "exactly one folder query param is required" },
        400,
      );
    }

    let sourceFolder: string;
    let folder: ReturnType<typeof mapZohoFolder>;
    try {
      sourceFolder = normalizeZohoFolderPath(sourceFolders[0]!);
      folder = mapZohoFolder(sourceFolder);
    } catch {
      return c.json({ error: "folder query param is invalid" }, 400);
    }

    const mailboxParam = c.req.param("mailboxId");
    if (!mailboxParam) return c.json({ error: "Mailbox is required" }, 400);
    const mailboxId = decodeURIComponent(mailboxParam).toLowerCase();
    const session = c.get("session");
    if (
      !session ||
      !(await dependencies.canAccessMailbox(c.env, session.sub, mailboxId))
    ) {
      return c.json({ error: "Mailbox access is required" }, 403);
    }

    if (!(await dependencies.mailboxExists(c.env, mailboxId))) {
      return c.json({ error: "Mailbox not found" }, 404);
    }

    if (!folder) {
      return c.json(
        { status: "skipped", reason: "excluded-folder", folder: sourceFolder },
        200,
      );
    }

    const raw = await dependencies.readRawEmail(c);
    if (raw.byteLength === 0) {
      return c.json({ error: "empty message body" }, 400);
    }
    if (raw.byteLength > MAX_EMAIL_SIZE) {
      return c.json({ error: "message exceeds size limit" }, 413);
    }

    const rawSha256 = await sha256RawEmail(raw);
    let parsed: Email;
    try {
      parsed = await dependencies.parseRawEmail(raw);
    } catch {
      return c.json({ error: "invalid RFC822 message" }, 400);
    }

    const result = await dependencies.importEmail(
      c.env,
      parsed,
      folder,
      mailboxId,
      rawSha256,
    );
    if (result.status === "imported") return c.json(result, 201);
    return c.json(
      result,
      result.reason === "in_progress" || result.reason === "identity_conflict"
        ? 409
        : 200,
    );
  };
}
