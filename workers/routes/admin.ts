// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Admin console (ADMIN role only): invite users, manage roles/activation, and
// revoke credentials without ever learning user-selected replacement secrets.
// Worker-rendered HTML (no React) — locked-decisions D-23, D-62, D-64.

import { Hono, type Context } from "hono";
import { USER_ROLES, type UserRole } from "../db/users-schema";
import {
  listUsers,
  getUserById,
  getUserByEmail,
  revokeUserCredentials,
} from "../lib/users";
import {
  hashPassword,
  generateMcpToken,
  type SessionClaims,
} from "../lib/auth";
import { provisionAccount } from "../lib/account-provisioning";
import { systemPromptFor } from "../lib/prompts";
import { escapeHtml } from "../lib/email-helpers";
import {
  isAddressInConfiguredMailDomains,
  normalizeMailAddress,
} from "../lib/mail-address";
import { pageShell, brandLogo, resolveBrand, type BrandConfig } from "./brand";
import { adminQuizApp } from "../quiz/admin-routes";
import type { Env } from "../types";
import {
  MailboxAccessError,
  mailboxAccess,
} from "../lib/mailbox-access";
import { renderAdminMailboxesPage } from "./admin-mailboxes-page";
import { renderAdminAiCostPage } from "./admin-ai-cost-page.ts";
import { resolveAiCostControlConfig } from "../lib/ai-cost-control.ts";
import { createAiCostController } from "../lib/ai-cost-control-d1.ts";
import { credentialRecoveryWorkflow } from "../lib/credential-recovery-runtime.ts";
import { drainCredentialRecoveryDeliveries } from "../lib/credential-recovery-delivery-outbox.ts";
import {
  maskedRecoveryAddress,
  recoveryAddressFor,
} from "../lib/recovery-directory.ts";
import { accountLifecycle } from "../lib/account-lifecycle-runtime.ts";
import { isSemanticSearchEnabled } from "../lib/features.ts";
import { createAdminReadDisclosureGuard } from "./admin-read-disclosure-guard.ts";
import { requireAgentConnectionReconciliation } from "../lib/agent-connection-revocation-outbox.ts";
import { adminInboundRecoveryApp } from "./admin-inbound-recovery.ts";
import { adminOutboundRecoveryApp } from "./admin-outbound-recovery.ts";
import { createAdminImportRouteHandler } from "./admin-import.ts";

type AdminEnv = { Bindings: Env; Variables: { session?: SessionClaims } };

function shell(brand: BrandConfig, body: string): string {
  return pageShell(
    brand,
    `Admin · ${brand.appName}`,
    `<div class="wrap">${body}</div>`,
  );
}

const adminApp = new Hono<AdminEnv>();

async function issueSetupLink(
  c: Context<AdminEnv>,
  user: NonNullable<Awaited<ReturnType<typeof getUserById>>>,
) {
  if (user.is_active !== 1) {
    throw new Error("Inactive accounts cannot receive setup links.");
  }
  if (user.ownership_confirmed_at !== null) {
    throw new Error(
      "Claimed accounts use owner-initiated recovery from the sign-in page.",
    );
  }
  const recoveryEmail = recoveryAddressFor(
    c.env.ACCOUNT_RECOVERY_DIRECTORY,
    user.email,
    c.env.DOMAINS,
  );
  const issued = await credentialRecoveryWorkflow(c.env).issue({
    purpose: "setup",
    userId: user.id,
    loginEmail: user.email,
    recoveryEmail,
    issuedBy: c.get("session")!.sub,
    origin: resolveBrand(c.env.BRAND).mailOrigin,
  });
  if (issued.issuance !== "issued") {
    throw new Error(
      issued.issuance === "rate_limited"
        ? "Setup issuance is temporarily rate limited."
        : "The account is no longer eligible for setup.",
    );
  }
  try {
    const maintenance = drainCredentialRecoveryDeliveries(c.env);
    c.executionCtx.waitUntil(maintenance);
  } catch {
    // The durable outbox is authoritative. Cron will retry delivery.
  }
  return issued;
}

// Gate: ADMIN only (the app-level gate already guarantees a valid session).
adminApp.use("*", async (c, next) => {
  const session = c.get("session");
  if (!session) return c.redirect("/login", 302);
  if (session.role !== "ADMIN") return c.text("Forbidden", 403);
  return next();
});
adminApp.use(
  "*",
  createAdminReadDisclosureGuard({
    checkAdministrator: async (env, userId) => {
      try {
        await mailboxAccess(env).requireMailboxAdministrator(userId);
        return true;
      } catch (error) {
        if (error instanceof MailboxAccessError && error.code === "FORBIDDEN") {
          return false;
        }
        throw error;
      }
    },
  }),
);

// Quiz admin console (open/close, edit questions, grade, results, seed). Mounted
// inside adminApp so it inherits the ADMIN-only guard above.
adminApp.route("/quizzes", adminQuizApp);
adminApp.route("/", adminInboundRecoveryApp);
adminApp.route("/", adminOutboundRecoveryApp);

adminApp.get("/ai-cost", async (c) => {
  const config = resolveAiCostControlConfig(c.env);
  const month = await createAiCostController(c.env, config).getCurrentMonth();
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  return c.html(
    renderAdminAiCostPage(
      resolveBrand(c.env.BRAND),
      month,
      config,
      ok
        ? { tone: "ok", message: ok }
        : err
          ? { tone: "err", message: err }
          : undefined,
    ),
  );
});

adminApp.post("/ai-cost/review", async (c) => {
  const form = await c.req.parseBody();
  const capUsd = Number(form.capUsd);
  const reason = String(form.reason ?? "").trim();
  const newApprovedBudgetMicros = Math.round(capUsd * 1_000_000);
  if (
    !Number.isFinite(capUsd) ||
    !Number.isSafeInteger(newApprovedBudgetMicros) ||
    newApprovedBudgetMicros <= 0 ||
    reason.length < 10
  ) {
    return c.redirect(
      `/admin/ai-cost?err=${encodeURIComponent("Enter a valid higher cap and a review reason of at least 10 characters.")}`,
      302,
    );
  }
  try {
    await createAiCostController(c.env).approveMonthlyBudget({
      newApprovedBudgetMicros,
      reviewedBy: c.get("session")!.sub,
      reason,
    });
    return c.redirect(
      `/admin/ai-cost?ok=${encodeURIComponent(`Approved a $${capUsd.toFixed(2)} monthly AI cap.`)}`,
      302,
    );
  } catch (error) {
    return c.redirect(
      `/admin/ai-cost?err=${encodeURIComponent(error instanceof Error ? error.message : "The AI budget review could not be recorded.")}`,
      302,
    );
  }
});

adminApp.get("/mailboxes", async (c) => {
  const session = c.get("session")!;
  const [users, mailboxes] = await Promise.all([
    listUsers(c.env),
    mailboxAccess(c.env).listManagedMailboxes(session.sub),
  ]);
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  return c.html(
    renderAdminMailboxesPage(
      resolveBrand(c.env.BRAND),
      users,
      mailboxes,
      ok
        ? { tone: "ok", message: ok }
        : err
          ? { tone: "err", message: err }
          : undefined,
    ),
  );
});

adminApp.get("/users", async (c) => {
  const brand = resolveBrand(c.env.BRAND);
  const users = await listUsers(c.env);
  const recoveryDisplays = new Map(
    users.map((user) => {
      try {
        return [
          user.id,
          maskedRecoveryAddress(
            recoveryAddressFor(
              c.env.ACCOUNT_RECOVERY_DIRECTORY,
              user.email,
              c.env.DOMAINS,
            ),
          ),
        ] as const;
      } catch {
        return [user.id, "Unavailable"] as const;
      }
    }),
  );
  const flash = c.req.query("ok")
    ? `<div class="flash ok">${escapeHtml(c.req.query("ok")!)}</div>`
    : c.req.query("err")
      ? `<div class="flash err">${escapeHtml(c.req.query("err")!)}</div>`
      : "";

  const rows = users
    .sort((a, b) => a.email.localeCompare(b.email))
    .map((u) => {
      const roleBadge =
        u.role === "ADMIN"
          ? `<span class="badge admin">ADMIN</span>`
          : `<span class="badge">AGENT</span>`;
      const status =
        u.is_active === 1
          ? `<form class="inline" method="post" action="/admin/users/${u.id}/deactivate"><button class="sm" type="submit">Deactivate</button></form>`
          : `<span class="badge off">inactive</span> <form class="inline" method="post" action="/admin/users/${u.id}/activate"><button class="sm" type="submit">Activate</button></form>`;
      const ownership = u.ownership_confirmed_at
        ? `<span class="badge">claimed</span>`
        : `<span class="badge off">pending setup</span>`;
      const setupAction = u.ownership_confirmed_at || u.is_active !== 1
        ? ""
        : `<form class="inline" method="post" action="/admin/users/${u.id}/setup"><button class="sm" type="submit">Resend secure setup link</button></form>`;
      return `<tr>
        <td>${escapeHtml(u.email)} ${roleBadge}</td>
        <td>${escapeHtml(u.mailbox_address)}</td>
				<td>${ownership} ${escapeHtml(recoveryDisplays.get(u.id) ?? "Unavailable")}</td>
        <td>${status}
				  ${setupAction}
          <form class="inline" method="post" action="/admin/users/${u.id}/revoke"><button class="sm" type="submit">Revoke sessions and credentials</button></form>
        </td>
      </tr>`;
    })
    .join("");

  return c.html(
    shell(
      brand,
      `
	<div class="brandbar">${brandLogo(brand, { href: "/" })}
		<div class="row" style="gap:8px">
			<a class="btn secondary" style="padding:8px 12px;border-radius:10px;font-size:13px" href="/admin/ai-cost">AI costs</a>
			<a class="btn secondary" style="padding:8px 12px;border-radius:10px;font-size:13px" href="/admin/mailboxes">Mailboxes</a>
			<a class="btn secondary" style="padding:8px 12px;border-radius:10px;font-size:13px" href="/admin/quizzes">Quizzes</a>
			<form class="inline" method="post" action="/logout"><button class="sm secondary" type="submit">Sign out</button></form>
		</div></div>
  <h1 style="margin-top:14px">User administration</h1>
  ${flash}
  <div class="card">
    <h2 style="font-size:16px;margin-top:0">Create a user</h2>
    <form method="post" action="/admin/users">
      <div class="row">
        <div><label>Email</label><input name="email" type="email" placeholder="kareem@${brand.mailDomain}" required></div>
        <div><label>Display name</label><input name="name" type="text" placeholder="Kareem Hatem"></div>
      </div>
      <div class="row">
		<div><label>Role</label><select name="role">${USER_ROLES.map((r) => `<option value="${r}">${r}</option>`).join("")}</select><small>The platform recovery directory must cover this portal email.</small></div>
      </div>
      <button type="submit">Create user, mailbox &amp; send invitation</button>
    </form>
  </div>
  <div class="card">
    <h2 style="font-size:16px;margin-top:0">Users</h2>
    <div class="tablewrap"><table><thead><tr><th>User</th><th>Mailbox</th><th>External recovery</th><th>Actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4">No users yet.</td></tr>`}</tbody></table></div>
  </div>`,
    ),
  );
});

adminApp.post("/mailboxes/:mailboxId/semantic-rebuild", async (c) => {
  const brand = resolveBrand(c.env.BRAND);
  if (
    !isSemanticSearchEnabled(c.env.FEATURES, brand.id) ||
    !c.env.SEMANTIC_INDEX
  ) {
    return c.redirect(
      `/admin/mailboxes?err=${encodeURIComponent("Meaning search is not enabled in this environment.")}`,
      302,
    );
  }
  const mailboxId = normalizeMailAddress(c.req.param("mailboxId"));
  const managed = await mailboxAccess(c.env).listManagedMailboxes(
    c.get("session")!.sub,
  );
  if (
    !mailboxId ||
    !managed.some(
      (mailbox) => mailbox.address === mailboxId && mailbox.is_active === 1,
    )
  ) {
    return c.redirect(
      `/admin/mailboxes?err=${encodeURIComponent("Active Mailbox not found.")}`,
      302,
    );
  }
  try {
    const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
    await stub.rebuildSemanticIndex(mailboxId);
    return c.redirect(
      `/admin/mailboxes?ok=${encodeURIComponent("Meaning index rebuild scheduled.")}`,
      302,
    );
  } catch {
    return c.redirect(
      `/admin/mailboxes?err=${encodeURIComponent("Meaning index rebuild could not be scheduled.")}`,
      302,
    );
  }
});

adminApp.post("/users", async (c) => {
  const form = await c.req.parseBody();
  const email = normalizeMailAddress(String(form.email || ""));
  const roleRaw = String(form.role || "AGENT");
  const role: UserRole = roleRaw === "ADMIN" ? "ADMIN" : "AGENT";

  if (!email) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("Invalid email address.")}`,
      302,
    );
  }
  if (!isAddressInConfiguredMailDomains(email, c.env.DOMAINS)) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("Email address must use a configured mail domain.")}`,
      302,
    );
  }
  if (await getUserByEmail(c.env, email)) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("A user with that email already exists.")}`,
      302,
    );
  }
  const name = String(form.name || "").trim() || email.split("@")[0];
  let recoveryEmail: string;
  try {
    recoveryEmail = recoveryAddressFor(
      c.env.ACCOUNT_RECOVERY_DIRECTORY,
      email,
      c.env.DOMAINS,
    );
  } catch {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("The platform recovery directory has no valid entry for this account.")}`,
      302,
    );
  }

  const { hash, salt } = await hashPassword(
    generateMcpToken(),
    c.env.JWT_SECRET,
  );
  let user: NonNullable<Awaited<ReturnType<typeof getUserById>>>;
  try {
    user = await provisionAccount(c.env, {
      email,
      passwordHash: hash,
      passwordSalt: salt,
      role,
      mailboxAddress: email,
      displayName: name,
      mailboxSettings: {
        agentSystemPrompt: systemPromptFor(resolveBrand(c.env.BRAND).id),
      },
    });
  } catch (error) {
    console.error("[admin] failed to create user and mailbox", {
      operation: "admin_account_provisioning",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("User and mailbox could not be created. Please retry or inspect logs.")}`,
      302,
    );
  }
  try {
    await issueSetupLink(c, user);
  } catch (error) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent(`User was created, but the invitation could not be issued: ${error instanceof Error ? error.message : "unknown error"}`)}`,
      302,
    );
  }

  return c.redirect(
    `/admin/users?ok=${encodeURIComponent(`Created ${email} (${role}) and queued a secure invitation for delivery.`)}`,
    302,
  );
});

adminApp.post("/users/:id/deactivate", async (c) => {
  await accountLifecycle(c.env).deactivate(c.req.param("id"));
  return c.redirect(
    `/admin/users?ok=${encodeURIComponent("User deactivated.")}`,
    302,
  );
});

adminApp.post("/users/:id/activate", async (c) => {
  await accountLifecycle(c.env).activate(c.req.param("id"));
  return c.redirect(
    `/admin/users?ok=${encodeURIComponent("User activated.")}`,
    302,
  );
});

adminApp.post("/users/:id/setup", async (c) => {
  const user = await getUserById(c.env, c.req.param("id"));
  if (!user)
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("User not found.")}`,
      302,
    );
  try {
    await issueSetupLink(c, user);
    const message = `Secure setup link queued for ${user.email}. Delivery retries automatically until the link expires.`;
    return c.redirect(
      `/admin/users?ok=${encodeURIComponent(message)}`,
      302,
    );
  } catch (error) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent(error instanceof Error ? error.message : "Setup link could not be issued.")}`,
      302,
    );
  }
});

adminApp.post("/users/:id/revoke", async (c) => {
  const user = await getUserById(c.env, c.req.param("id"));
  if (!user)
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("User not found.")}`,
      302,
    );
  const { hash, salt } = await hashPassword(
    generateMcpToken(),
    c.env.JWT_SECRET,
  );
  await revokeUserCredentials(c.env, user.id, hash, salt);
  await requireAgentConnectionReconciliation(c.env, {
    userId: user.id,
    scope: "ACTOR",
  });
  return c.redirect(
    `/admin/users?ok=${encodeURIComponent(`Revoked sessions and credentials for ${user.email}. The owner can recover from the sign-in page.`)}`,
    302,
  );
});

// ── One-time Zoho mail importer (WISER-241) ─────────────────────────
//
// POST /admin/import/:mailboxId?folder=<zohoFolder> with a raw RFC822 .eml body.
// ADMIN-only (inherited guard). Feeds historical mail through the shared store path,
// preserves the original date, routes the
// original folder (Trash/Spam dropped), and marks history read — and never fires
// push. Idempotent: the internal id is derived from the message, so re-running
// skips anything already imported (R2 keys are keyed on that id too). Removable
// after the migration.
adminApp.post("/import/:mailboxId", createAdminImportRouteHandler());

export { adminApp };
