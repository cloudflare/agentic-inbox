/**
 * Sender text for list rows.
 *
 * Threaded rows carry `participant_names`, which the durable object builds as
 * `GROUP_CONCAT(DISTINCT COALESCE(NULLIF(TRIM(sender_name), ''), sender))` - so
 * every entry is already a display name when one exists and a bare address
 * otherwise, comma joined. A display name containing a comma is therefore
 * indistinguishable from two participants; that ambiguity lives in the stored
 * format and cannot be recovered here.
 */

/** Local parts that identify a machine, not a person - the domain is the identity. */
const GENERIC_MAILBOXES = new Set([
	"no-reply",
	"noreply",
	"do-not-reply",
	"donotreply",
	"notification",
	"notifications",
	"mailer-daemon",
	"postmaster",
	"bounce",
	"bounces",
]);

function titleCase(value: string): string {
	return value.replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

function stripQuotes(value: string): string {
	return value.trim().replace(/^"(.*)"$/s, "$1").trim();
}

/** `"Acme Billing <no-reply@acme.com>"` and `"no-reply@acme.com"` both reduce to `Acme`. */
function humanizeAddress(value: string): string {
	const address = value.replace(/^[^<]*</, "").replace(/>.*$/, "").trim();
	const at = address.lastIndexOf("@");
	if (at <= 0) return address;

	const local = address.slice(0, at);
	const domain = address.slice(at + 1);
	const labels = domain.split(".").filter(Boolean);
	const source =
		GENERIC_MAILBOXES.has(local.toLowerCase()) && labels.length > 0
			? labels[Math.max(0, labels.length - 2)]
			: local;

	const spaced = source.replace(/[._+-]+/g, " ").trim();
	if (!spaced) return address;
	return spaced === spaced.toLowerCase() ? titleCase(spaced) : spaced;
}

function toLabel(value: string): string {
	const cleaned = stripQuotes(value);
	return cleaned.includes("@") ? humanizeAddress(cleaned) : cleaned;
}

function splitEntries(value: string | null | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Resolve the sender text plus the full value to expose via `title`, so a
 * truncated row never loses information the user cannot get back.
 */
export function formatSenderLabel(email: {
	participant_names?: string | null;
	participants?: string | null;
	sender_name?: string | null;
	sender?: string | null;
}): { text: string; title: string } {
	const preferred =
		splitEntries(email.participant_names).length > 0
			? splitEntries(email.participant_names)
			: splitEntries(email.participants).length > 0
				? splitEntries(email.participants)
				: splitEntries(stripQuotes(email.sender_name ?? "") || (email.sender ?? ""));

	const labels: string[] = [];
	for (const entry of preferred) {
		const label = toLabel(entry);
		if (label && !labels.includes(label)) labels.push(label);
	}

	const fallback = (email.sender ?? "").trim();
	const title = (
		email.participant_names?.trim() ||
		email.participants?.trim() ||
		email.sender_name?.trim() ||
		fallback
	).trim();

	if (labels.length === 0) return { text: fallback || "Unknown sender", title: title || fallback };
	if (labels.length <= 3) return { text: labels.join(", "), title: title || labels.join(", ") };
	return {
		text: `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`,
		title: title || labels.join(", "),
	};
}
