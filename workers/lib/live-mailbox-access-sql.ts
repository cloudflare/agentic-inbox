/**
 * Live mailbox access predicate. An active administrator is member-equivalent on
 * every active mailbox; everyone else needs Personal ownership or Shared
 * membership. The mailbox and the user must both still be active either way.
 *
 * The mailbox and user are expressions rather than fixed placeholders so a
 * statement that already has the pair in scope as columns (a correlated UPDATE,
 * say) reuses this one definition instead of restating the rule.
 */
export function liveMailboxAccessSql(
	mailboxExpression = "?",
	userExpression = "?",
): string {
	return `EXISTS (
	SELECT 1
	FROM users AS owner
	JOIN mailboxes AS mailbox ON mailbox.id = ${mailboxExpression}
	WHERE owner.id = ${userExpression}
	  AND owner.is_active = 1
	  AND mailbox.is_active = 1
	  AND (
	    owner.role = 'ADMIN'
	    OR (mailbox.type = 'PERSONAL' AND mailbox.owner_user_id = owner.id)
	    OR (
	      mailbox.type = 'SHARED'
	      AND EXISTS (
	        SELECT 1 FROM mailbox_memberships AS membership
	        WHERE membership.mailbox_id = mailbox.id
	          AND membership.user_id = owner.id
	      )
	    )
	  )
)`;
}

/** Bound form for statements that pass the mailbox id and user id positionally. */
export const LIVE_MAILBOX_ACCESS_SQL = liveMailboxAccessSql();
