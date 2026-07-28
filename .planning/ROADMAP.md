# AI Mail Client Rebuild Roadmap

Source of truth: `/Users/heshammohamed/Documents/hesham-os/wiserchat/initiatives/team-mail-portal/master-rebuild-program-2026-07-11.md`.

## Destination

Deliver a state-of-the-art, standalone, AI-powered mail client that preserves the existing mail transport, provides premium personal mail, offers lightweight Shared Mailbox access, keeps read state per mailbox, attributes supported actions, and stays independent from the Whispyr CRM and WiserChat application systems and repositories.

## Locked boundaries

- Personal Mailboxes are private from other agents; administrators reach every mailbox.
- Shared Mailboxes use a simple administrator-managed member list.
- Every Shared Mailbox member may read and reply as that address.
- Read/unread is mailbox-wide.
- Supported actions record the acting human, rule, or AI actor.
- Do not add assignment, ownership, comments, mentions, SLAs, due dates, workflow status, workload management, granular mailbox permissions, or shared-inbox analytics.
- AI is available throughout the client but deterministic mail state, authorization, delivery truth, approval, audit, and undo remain authoritative.
- Mail intelligence derives only from portal mail and attachments. No code, database, API, package, or runtime coupling to Whispyr CRM or WiserChat.
- Target incremental AI cost: likely $0 to $15/month at small-team volume, with a $25 alert and $50 review threshold during rollout.

## Phase 0: baseline and implementation contracts

Status: substantially complete

- Complete authenticated route/state teardown with production-shaped seeded mail.
- Record public API and user-flow test seams.
- Convert the safety, shared-access, client, AI, and standalone-intelligence program into dependency-ordered vertical slices.
- Establish cost, performance, security, accessibility, and visual QA baselines.

Exit: the first safety vertical slice and its migrations/tests are implementation-ready.

## Phase 1: safety and truthful mail state

Status: implemented, integrated review in progress

- Delete to Trash, restore, and explicit permanent deletion.
- Prevent folder and mailbox deletion from silently losing or orphaning data.
- Persist truthful delivery state and expose failure/retry.
- Add explicit loading/error/retry/offline states.
- Add attributable activity records at state-changing public seams.
- Gate destructive AI/MCP actions behind the same safe semantics.

Exit: ordinary UI, API, rule, or AI actions cannot silently destroy mail or misrepresent delivery.

## Phase 2: Conversation and lightweight Shared Mailbox foundation

Status: implemented, integrated review in progress

- Stable Conversation identity.
- Personal versus Shared Mailbox type.
- Administrator-managed Shared Mailbox member list.
- Authorized members can see, read, compose, and reply from the shared address.
- Mailbox-wide read state.
- Human/rule/AI actor attribution.
- Identical authorization in UI, API, agent, and MCP.

Exit: three users can independently access one Shared Mailbox, share its read state, reply as it, and see attributable actions while an unauthorized user cannot discover it.

## Phase 3: premium mail client

Status: in progress

- New Today/Mailboxes/People/Automations/Settings information architecture.
- Keyboard command system and shortcut discovery.
- Multi-select and bulk triage.
- Snooze, send later, follow-up reminders, undo send, and undo action.
- Labels and Saved Views.
- Contacts and recipient autocomplete.
- Attachment preview/discovery.
- Realtime, offline/reconnect, responsive, accessible, and content-extreme behavior.
- Cohesive settings, bulk send, and administration inside the main shell.

Exit: core triage/search/compose journeys meet approved performance, accessibility, mobile, and visual quality targets.

## Phase 4: proactive AI and automation

Status: in progress

- Tiered models for classification, summaries, follow-up detection, retrieval, and drafting.
- Incremental conversation summaries and semantic indexing.
- Natural-language and semantic search with Message/attachment citations.
- Evidence-backed follow-up and Commitment insights.
- Versioned inbound-only deterministic rules with dry run, explanation, audit, retry, loop prevention, retained tests, and restore-as-draft are implemented.
- AI approval inbox, policy scopes, run history, evaluation datasets, budgets, and alerts.
- Preserve MCP/future CLI behind the same policy layer.

Exit: every AI result is permission-filtered, attributable, explainable, measured, and within the agreed budget controls.

## Phase 5: standalone mail intelligence graph

Status: in progress

- Mail-derived People, relationship timelines, related Conversations, attachment context, and cited actor-private Relationship Briefs are implemented; explicit alias correction and domain views remain pending.
- Permission-aware semantic retrieval over portal-owned mail and files.
- Evidence, correction, invalidation, and provenance for derived facts.
- No integration with Whispyr CRM or WiserChat application code or data.

Exit: the client can answer relationship/history questions from cited portal data while remaining operationally independent.

## Phase 6: hardening, polish, and rollout

Status: pending

- Authentication/session/device hardening.
- Backup, restore, retention, export, and recovery drills.
- Performance, security, accessibility, responsive/PWA, offline, and visual QA.
- AI shadow mode, cost monitoring, evaluation thresholds, and staged team rollout.
- Full standards and specification review, cleanup, documentation, and final audit.

Exit: all release gates pass, recovery is rehearsed, and the team can rely on the portal without a parallel inbox system.
