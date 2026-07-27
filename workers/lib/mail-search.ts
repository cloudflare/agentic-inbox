import { InternalFolders } from "../../shared/folders.ts";
import { hasAttachmentsSql } from "./list-projection.ts";
import {
	MAIL_SEARCH_LIMITS,
	SearchQueryError,
	parseSearchQuery,
	type ParsedSearch,
} from "../../shared/mail-search.ts";
import {
	SAVED_VIEW_SORT_COLUMNS,
	type SavedViewSortColumn,
	type SavedViewSortDirection,
} from "../../shared/saved-views.ts";

const MAX_DO_SQL_BOUND_PARAMETERS = 100;
const MAX_DO_LIKE_PATTERN_BYTES = 50;
const UTF8_ENCODER = new TextEncoder();

export interface MailSearchOptions {
	/** Legacy free-text seam used by tools and existing Saved Views. */
	query?: string;
	terms?: string[];
	phrases?: string[];
	label_id?: string;
	folder?: string | string[];
	from?: string | string[];
	to?: string | string[];
	subject?: string | string[];
	filename?: string | string[];
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
	sortColumn?: unknown;
	sortDirection?: unknown;
	page?: number;
	limit?: number;
}

export interface MailSearchPlan {
	dataSql: string;
	dataParams: Array<string | number>;
	countSql: string;
	countParams: Array<string | number>;
	page: number;
	limit: number;
}

class Parameters {
	readonly values: Array<string | number> = [];

	add(value: string | number): string {
		this.values.push(value);
		return `?${this.values.length}`;
	}
}

function boundedValues(
	value: string | string[] | undefined,
	label = "Search filter",
	maxValues: number = MAIL_SEARCH_LIMITS.valuesPerFilter,
): string[] {
	const source = Array.isArray(value) ? value : value ? [value] : [];
	if (
		source.length > maxValues ||
		source.some((item) => item.length > MAIL_SEARCH_LIMITS.tokenChars)
	) {
		throw new SearchQueryError(
			"QUERY_TOO_LARGE",
			`${label} contains too many or oversized values`,
		);
	}
	const values = source
		.map((item) => item.trim())
		.filter(Boolean);
	return [...new Set(values)].slice(0, maxValues);
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

function likePattern(value: string): string {
	const pattern = `%${escapeLike(value)}%`;
	if (UTF8_ENCODER.encode(pattern).byteLength > MAX_DO_LIKE_PATTERN_BYTES) {
		throw new SearchQueryError(
			"QUERY_TOO_LARGE",
			"Search value exceeds the mailbox pattern limit",
		);
	}
	return pattern;
}

function like(parameter: string, column: string): string {
	return `COALESCE(${column}, '') LIKE ${parameter} ESCAPE '\\' COLLATE NOCASE`;
}

interface NormalizedSearch {
	needles: string[];
	from: string[];
	to: string[];
	subject: string[];
	filename: string[];
	folder: string[];
	labelId?: string;
	dateStart?: string;
	dateEnd?: string;
	isRead?: boolean;
	isStarred?: boolean;
	hasAttachment: boolean;
}

function mergeParsed(options: MailSearchOptions): NormalizedSearch {
	let parsed: ParsedSearch | undefined;
	if (options.query?.trim()) parsed = parseSearchQuery(options.query);
	const needles = [
		...new Set(
			[
				...(parsed?.terms ?? []),
				...(parsed?.phrases ?? []),
				...boundedValues(
					options.terms,
					"Search terms",
					MAIL_SEARCH_LIMITS.tokens,
				),
				...boundedValues(
					options.phrases,
					"Search phrases",
					MAIL_SEARCH_LIMITS.tokens,
				),
			]
				.map((value) => value.trim())
				.filter(Boolean),
		),
	];
	if (needles.length > MAIL_SEARCH_LIMITS.tokens) {
		throw new SearchQueryError(
			"QUERY_TOO_LARGE",
			`Search cannot contain more than ${MAIL_SEARCH_LIMITS.tokens} terms`,
		);
	}
	if (options.label_id && options.label_id.trim().length > 128) {
		throw new SearchQueryError("QUERY_TOO_LARGE", "Label filter is too long");
	}
	for (const [label, date] of [
		["Start date", options.date_start ?? parsed?.date_start],
		["End date", options.date_end ?? parsed?.date_end],
	] as const) {
		if (date && (date.length > 40 || !Number.isFinite(Date.parse(date)))) {
			throw new SearchQueryError("INVALID_QUERY", `${label} is invalid`);
		}
	}
	return {
		needles,
		from: boundedValues(options.from ?? parsed?.from, "Sender filter"),
		to: boundedValues(options.to ?? parsed?.to, "Recipient filter"),
		subject: boundedValues(options.subject ?? parsed?.subject, "Subject filter"),
		filename: boundedValues(options.filename ?? parsed?.filename, "Filename filter"),
		folder: boundedValues(options.folder ?? parsed?.folder, "Folder filter"),
		labelId: options.label_id?.trim() || undefined,
		dateStart: options.date_start ?? parsed?.date_start,
		dateEnd: options.date_end ?? parsed?.date_end,
		isRead: options.is_read ?? parsed?.is_read,
		isStarred: options.is_starred ?? parsed?.is_starred,
		hasAttachment: Boolean(options.has_attachment ?? parsed?.has_attachment),
	};
}

function orLike(
	params: Parameters,
	values: string[],
	columns: readonly string[],
): string | undefined {
	if (!values.length) return undefined;
	const clauses = values.map((value) => {
		const parameter = params.add(likePattern(value));
		return `(${columns.map((column) => like(parameter, column)).join(" OR ")})`;
	});
	return `(${clauses.join(" OR ")})`;
}

function fragments(search: NormalizedSearch, params: Parameters) {
	const conditions = [`e.folder_id <> '${InternalFolders.RETIRED_OUTBOUND}'`];
	const relevance: string[] = [];
	const attachmentMatchValues: string[] = [];

	for (const needle of search.needles) {
		const attachmentMatchValue = likePattern(needle);
		const parameter = params.add(attachmentMatchValue);
		attachmentMatchValues.push(attachmentMatchValue);
		conditions.push(`(
			${like(parameter, "e.subject")} OR ${like(parameter, "e.body")} OR
			${like(parameter, "e.sender")} OR ${like(parameter, "e.recipient")} OR
			${like(parameter, "e.cc")} OR ${like(parameter, "e.bcc")} OR
			EXISTS (
				SELECT 1 FROM attachments search_attachment
				WHERE search_attachment.email_id = e.id
					AND ${like(parameter, "search_attachment.filename")}
			)
		)`);
		relevance.push(`
			CASE WHEN ${like(parameter, "e.subject")} THEN 8 ELSE 0 END +
			CASE WHEN ${like(parameter, "e.sender")} OR ${like(parameter, "e.recipient")} THEN 4 ELSE 0 END +
			CASE WHEN ${like(parameter, "e.body")} THEN 2 ELSE 0 END +
			CASE WHEN EXISTS (
				SELECT 1 FROM attachments score_attachment
				WHERE score_attachment.email_id = e.id
					AND ${like(parameter, "score_attachment.filename")}
			) THEN 6 ELSE 0 END
		`);
	}

	for (const [values, columns] of [
		[search.from, ["e.sender"]],
		[search.to, ["e.recipient", "e.cc", "e.bcc"]],
		[search.subject, ["e.subject"]],
	] as const) {
		const clause = orLike(params, values, columns);
		if (clause) conditions.push(clause);
	}
	if (search.filename.length) {
		const clause = orLike(params, search.filename, ["filter_attachment.filename"]);
		conditions.push(`EXISTS (
			SELECT 1 FROM attachments filter_attachment
			WHERE filter_attachment.email_id = e.id AND ${clause}
		)`);
		for (const value of search.filename) {
			attachmentMatchValues.push(likePattern(value));
		}
	}
	if (search.folder.length) {
		const folderClauses = search.folder.map((folder) => {
			const parameter = params.add(folder);
			return `(lower(search_folder.id) = lower(${parameter}) OR lower(search_folder.name) = lower(${parameter}))`;
		});
		conditions.push(`EXISTS (
			SELECT 1 FROM folders search_folder
			WHERE search_folder.id = e.folder_id AND (${folderClauses.join(" OR ")})
		)`);
	}
	if (search.labelId) {
		const parameter = params.add(search.labelId);
		conditions.push(`EXISTS (
			SELECT 1 FROM email_labels search_label
			WHERE search_label.email_id = e.id AND search_label.label_id = ${parameter}
		)`);
	}
	if (search.dateStart) conditions.push(`e.date >= ${params.add(search.dateStart)}`);
	if (search.dateEnd) conditions.push(`e.date < ${params.add(search.dateEnd)}`);
	if (search.isRead !== undefined) conditions.push(`e.read = ${params.add(search.isRead ? 1 : 0)}`);
	if (search.isStarred !== undefined) conditions.push(`e.starred = ${params.add(search.isStarred ? 1 : 0)}`);
	if (search.hasAttachment) {
		conditions.push("EXISTS (SELECT 1 FROM attachments has_attachment WHERE has_attachment.email_id = e.id)");
	}

	return {
		where: `WHERE ${conditions.join(" AND ")}`,
		relevance: relevance.length ? relevance.map((part) => `(${part})`).join(" + ") : "0",
		attachmentMatchValues,
	};
}

function explicitSort(options: MailSearchOptions): {
	column: SavedViewSortColumn;
	direction: SavedViewSortDirection;
} | null {
	if (
		typeof options.sortColumn !== "string" ||
		!SAVED_VIEW_SORT_COLUMNS.includes(options.sortColumn as SavedViewSortColumn)
	) return null;
	return {
		column: options.sortColumn as SavedViewSortColumn,
		direction: options.sortDirection === "ASC" ? "ASC" : "DESC",
	};
}

function matchCenteredSnippet(params: Parameters, needles: string[]): string {
	if (!needles.length) return "SUBSTR(COALESCE(e.body, ''), 1, 220)";
	const matches = needles.map((value) => {
		const needle = params.add(value);
		const position = `instr(lower(COALESCE(e.body, '')), lower(${needle}))`;
		return `WHEN ${position} > 0 THEN CASE
			WHEN ${position} <= 90 THEN SUBSTR(COALESCE(e.body, ''), 1, 220)
			ELSE '…' || SUBSTR(COALESCE(e.body, ''), ${position} - 89, 220)
		END`;
	});
	return `CASE
		${matches.join("\n")}
		ELSE SUBSTR(COALESCE(e.body, ''), 1, 220)
	END`;
}

/**
 * Build a bounded, target-compatible SQLite plan. This deliberately uses
 * escaped LIKE queries instead of assuming FTS5 is available in Durable Objects.
 */
export function buildMailSearchPlan(options: MailSearchOptions): MailSearchPlan {
	const search = mergeParsed(options);
	const page = Number.isInteger(options.page) && Number(options.page) > 0
		? Number(options.page)
		: 1;
	const limit = Number.isInteger(options.limit)
		? Math.min(Math.max(Number(options.limit), 1), 100)
		: 25;
	const dataParams = new Parameters();
	const data = fragments(search, dataParams);
	const snippet = matchCenteredSnippet(dataParams, search.needles);
	const matchedAttachment = data.attachmentMatchValues.length
		? `(SELECT MIN(result_attachment.filename) FROM attachments result_attachment
			 WHERE result_attachment.email_id = e.id AND (
				${data.attachmentMatchValues
					.map((value) => like(dataParams.add(value), "result_attachment.filename"))
					.join(" OR ")}
			 ))`
		: "NULL";
	const selectedSort = explicitSort(options);
	const sortColumns: Record<SavedViewSortColumn, string> = {
		date: "e.date",
		sender: "e.sender",
		recipient: "e.recipient",
		subject: "e.subject",
		read: "e.read",
		starred: "e.starred",
	};
	const order = selectedSort
		? `${sortColumns[selectedSort.column]} ${selectedSort.direction}, e.id ASC`
		: "relevance DESC, e.date DESC, e.id ASC";
	const limitParameter = dataParams.add(limit);
	const offsetParameter = dataParams.add((page - 1) * limit);
	const dataSql = `
		SELECT e.id, e.subject, e.sender, e.sender_name, e.recipient, e.cc, e.bcc, e.date,
			e.read, e.starred, e.in_reply_to, e.email_references,
			${hasAttachmentsSql("e")} AS has_attachments,
			e.thread_id, e.folder_id, e.snooze_source_folder_id, e.snoozed_until,
			EXISTS(SELECT 1 FROM email_body_objects body_object
			       WHERE body_object.email_id = e.id) AS body_external,
			${snippet} AS snippet,
			${data.relevance} AS relevance,
			${matchedAttachment} AS matched_attachment_filename,
			f.name AS folder_name
		FROM emails e
		LEFT JOIN folders f ON e.folder_id = f.id
		${data.where}
		ORDER BY ${order}
		LIMIT ${limitParameter} OFFSET ${offsetParameter}`;

	const countParams = new Parameters();
	const count = fragments(search, countParams);
	const countSql = `SELECT COUNT(*) AS total FROM emails e ${count.where}`;
	if (
		dataParams.values.length > MAX_DO_SQL_BOUND_PARAMETERS ||
		countParams.values.length > MAX_DO_SQL_BOUND_PARAMETERS
	) {
		throw new SearchQueryError(
			"QUERY_TOO_LARGE",
			"Search uses too many combined filters",
		);
	}
	return {
		dataSql,
		dataParams: dataParams.values,
		countSql,
		countParams: countParams.values,
		page,
		limit,
	};
}
