# Personal Follow-up Reminders Contract

Status: domain and persistence contract only. Routes, UI, mailbox ingestion, and notification delivery are intentionally not mounted yet.

## Product boundary

A follow-up reminder belongs to one user, including when its mail lives in a Shared Mailbox. It is private productivity state. It is not assignment, ownership, mailbox status, an SLA, a team due date, or a signal that another member can see.

Administrators do not gain reminder visibility through their role. Every user-initiated list or mutation must recheck live mailbox access and scope storage reads by both `owner_user_id` and `mailbox_address`.

## Identity and lifecycle

The client identifies one stored email. The mailbox Durable Object derives the authoritative conversation, latest eligible baseline message, and stored ordering time. Client-supplied thread IDs, message IDs, and dates are never reminder authority.

Each reminder is tied to:

- one owner user;
- one mailbox address;
- one authoritative conversation key;
- the baseline message ID and baseline message date observed when the reminder was created.

The states are `active`, `completed`, and `dismissed`. Completion records either `manual` or `inbound_reply`. Dismissal records `dismissed`. Terminal records keep their original due time and baseline for auditability.

Only one active reminder may exist for an owner, mailbox, and conversation. A user changes an active reminder through typed operations:

- `dismiss`: terminally remove it from the user's working set;
- `complete`: terminally mark the personal task done;
- `snooze`: replace its reminder time while keeping it active.

All mutations use an expected version. Stale versions fail with a state conflict instead of overwriting newer user intent.

## Time rules and grouping

Reminder times must be valid future instants no more than one calendar year from authoritative server time. The service validates this on create and snooze.

The client supplies the next local midnight as an instant. Grouping is then deterministic:

- `overdue`: due before now;
- `today`: due at or after now and before the supplied next local midnight;
- `upcoming`: due at or after that midnight.

Each group sorts by reminder time, then reminder ID as a stable tie-breaker. Server timezone never decides the user's Today boundary.

## Automatic completion on reply

Only the inbound pipeline, after successfully persisting a message and establishing its canonical mailbox conversation, may request reply completion. User input, AI output, subject similarity, header dates, and arbitrary message IDs are not sufficient authority.

An inbound reply completes an active reminder only when:

- its conversation key matches;
- its message ID differs from the baseline message;
- its message date is newer than the baseline message date;
- the reminder owner still has live access to the mailbox.

The persisted inbound signal is inserted into the mailbox Durable Object queue in the same transaction as the email. A mailbox alarm retries transient D1 failures with bounded backoff. Queue identity is the internal inbound message ID, so a repeated alarm or duplicate signal is harmless. The persistence adapter rechecks active state, the baseline date, active user state, active mailbox state, and live mailbox access (Personal ownership, Shared membership, or an active administrator's role) inside one bounded SQL completion write. This makes access revocation atomic with completion and avoids per-owner query fan-out.

## Idempotency and privacy threats

Create requests carry a user-scoped idempotency key and a fingerprint of the stable mailbox, selected email ID, and due time. The immutable result snapshot stores the derived conversation baseline. Replaying the same request returns that original snapshot even if newer mail has since advanced the conversation. Reusing a key with different data fails closed.

Dismiss, complete, and snooze requests carry a user-scoped operation ID, expected version, and payload fingerprint. The operation ledger stores an immutable result snapshot, returns that prior result for an exact replay, and rejects a different payload under the same ID. The database uses a composite foreign key so an operation row cannot point at another owner's reminder.

The adapter must defend against IDOR by including owner and mailbox in every reminder lookup and mutation. Revoking mailbox access does not delete reminders, because access may later be restored, but the rows remain inaccessible and are excluded from inbound auto-completion until access returns. Deleting the user cascades both reminders and their operation ledger.

AI may suggest that a user create a reminder in a later reviewable flow. AI is never authoritative for access, state transitions, timestamps, completion, idempotency, or conversation identity.
