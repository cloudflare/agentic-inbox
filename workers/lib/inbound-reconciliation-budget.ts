export const WORKER_DEFAULT_SERVICE_SUBREQUEST_LIMIT = 10_000;
export const INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET = 9_000;

export const RECONCILIATION_LANE_OVERHEAD_SERVICE_SUBREQUESTS = 3;
// Repair, cleanup, active-index, and exhaustive raw lanes each use the standard
// cursor read/list/cursor write shape. The recent-minute lane is budgeted
// separately because it may inspect many closed minute prefixes per run.
export const RECONCILIATION_LANE_COUNT = 4;

export const INBOUND_REPAIR_ATTEMPT_RECONCILIATION_BATCH_SIZE = 20;
// Pending read + resolution read + finalize RPC + immutable resolution
// put/reread + guarded cleanup RPC + pending-ledger delete.
export const MAX_REPAIR_ATTEMPT_SERVICE_SUBREQUESTS_PER_ITEM = 7;

export const INBOUND_CLEANUP_INTENT_RECONCILIATION_BATCH_SIZE = 7;
export const MAX_CLEANUP_INTENT_DISCOVERY_LIST_CALLS = 514;
// Intent read + exhaustive two-prefix listing + manifest RPC + cleanup RPC +
// the three-call CAS transition used by the worst abandoned-intent branch.
export const MAX_CLEANUP_INTENT_SERVICE_SUBREQUESTS_PER_ITEM = 520;

// The active index receives priority so retained terminal raw history cannot
// hide a live orphan. One slot remains reserved for the exhaustive raw backstop.
export const INBOUND_ACTIVE_RECONCILIATION_BATCH_SIZE = 8;
export const INBOUND_RAW_BACKSTOP_RECONCILIATION_BATCH_SIZE = 1;
export const INBOUND_ARCHIVE_RECONCILIATION_BATCH_SIZE =
	INBOUND_ACTIVE_RECONCILIATION_BATCH_SIZE +
	INBOUND_RAW_BACKSTOP_RECONCILIATION_BATCH_SIZE;
// Archive head + receipt read + Mailbox truth RPCs + anomaly resolution +
// manifest RPC + 512 integrity heads + anomaly marker + failure-ledger delete.
export const MAX_ARCHIVE_SERVICE_SUBREQUESTS_PER_ITEM = 521;
// Active items additionally read terminal receipt metadata so stale markers can
// be removed without confusing a fresh enqueued/retrying receipt with terminal.
export const MAX_ACTIVE_ARCHIVE_SERVICE_SUBREQUESTS_PER_ITEM =
	MAX_ARCHIVE_SERVICE_SUBREQUESTS_PER_ITEM + 2;

export const INBOUND_RECENT_RAW_RECONCILIATION_BATCH_SIZE = 64;
export const INBOUND_RECENT_RAW_MAX_PREFIX_LIST_CALLS = 64;
// Receipt HEAD + exact quarantine receipt GET + create-only active-marker put.
// Non-quarantine items skip the GET, but all three calls are admitted so a
// historical forward-eligible quarantine cannot be hidden by terminal metadata.
export const MAX_RECENT_RAW_SERVICE_SUBREQUESTS_PER_ITEM = 3;
// The priority and fixed backstop cursors each use one read and one write. They
// share at most 64 closed-minute lists and 128 candidate objects per run.
export const RECENT_RAW_LANE_OVERHEAD_SERVICE_SUBREQUESTS =
	INBOUND_RECENT_RAW_MAX_PREFIX_LIST_CALLS + 4;

// Emergency-forward reconciliation uses one cursor read, one active-marker
// list, one cursor write, and a corrupt-cursor audit write. Per marker the
// corrupt-marker + exact forward-eligible-quarantine branch may read marker,
// receipt, and raw, CAS-repair/reread both sidecars, best-effort audit both
// repairs, CAS-claim/reread a generation, enqueue, and retain cleanup authority.
// Two Mailbox RPCs precede any receipt repair so a forward the consumer already
// settled against a live mailbox row is never resurrected.
export const EMERGENCY_FORWARD_RECONCILIATION_BATCH_SIZE = 8;
export const EMERGENCY_FORWARD_LANE_OVERHEAD_SERVICE_SUBREQUESTS = 4;
export const MAX_EMERGENCY_FORWARD_SERVICE_SUBREQUESTS_PER_ITEM = 15;

// Each lane spends one read, one list, and one cursor write outside its item
// loop. The per-item ceilings mirror the actual worst-case call graphs so an
// admitted page can finish without relying on a mid-item budget exception.
export const INBOUND_RECONCILIATION_WORST_CASE_SERVICE_SUBREQUESTS =
	RECONCILIATION_LANE_OVERHEAD_SERVICE_SUBREQUESTS *
		RECONCILIATION_LANE_COUNT +
	RECENT_RAW_LANE_OVERHEAD_SERVICE_SUBREQUESTS +
	INBOUND_REPAIR_ATTEMPT_RECONCILIATION_BATCH_SIZE *
		MAX_REPAIR_ATTEMPT_SERVICE_SUBREQUESTS_PER_ITEM +
	INBOUND_CLEANUP_INTENT_RECONCILIATION_BATCH_SIZE *
		MAX_CLEANUP_INTENT_SERVICE_SUBREQUESTS_PER_ITEM +
	INBOUND_ACTIVE_RECONCILIATION_BATCH_SIZE *
		MAX_ACTIVE_ARCHIVE_SERVICE_SUBREQUESTS_PER_ITEM +
	INBOUND_RECENT_RAW_RECONCILIATION_BATCH_SIZE *
		MAX_RECENT_RAW_SERVICE_SUBREQUESTS_PER_ITEM +
	INBOUND_RAW_BACKSTOP_RECONCILIATION_BATCH_SIZE *
		MAX_ARCHIVE_SERVICE_SUBREQUESTS_PER_ITEM +
	EMERGENCY_FORWARD_LANE_OVERHEAD_SERVICE_SUBREQUESTS +
	EMERGENCY_FORWARD_RECONCILIATION_BATCH_SIZE *
		MAX_EMERGENCY_FORWARD_SERVICE_SUBREQUESTS_PER_ITEM;

if (
	INBOUND_RECONCILIATION_WORST_CASE_SERVICE_SUBREQUESTS >
		INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET ||
	INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET >=
		WORKER_DEFAULT_SERVICE_SUBREQUEST_LIMIT
) {
	throw new Error(
		"Inbound reconciliation exceeds its service-subrequest budget",
	);
}
