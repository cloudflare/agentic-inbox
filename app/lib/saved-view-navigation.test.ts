import assert from "node:assert/strict";
import test from "node:test";
import {
  definitionFromFolderView,
  definitionFromSearchView,
  savedViewRoute,
} from "./saved-view-navigation.ts";
import { savedViewSearchParams } from "../../shared/saved-views.ts";
import { buildMailSearchPlan } from "../../workers/lib/mail-search.ts";
import { searchOptionsFromUrl } from "../../workers/routes/search.ts";

function appliedSearchSql(params: Record<string, string>): string {
	const url = new URL("https://mail.example.com/search");
	url.search = new URLSearchParams(params).toString();
	return buildMailSearchPlan(searchOptionsFromUrl(url)).dataSql;
}

test("folder views preserve label and sort filters", () => {
  const definition = definitionFromFolderView({
    folder: "inbox",
    searchParams: new URLSearchParams(
      "label_id=label_vip&sortColumn=sender&sortDirection=ASC",
    ),
  });
  assert.deepEqual(definition, {
    filters: { folder: "inbox", labelId: "label_vip" },
    sort: { column: "sender", direction: "ASC" },
  });
});

test("search views preserve the exact strict grammar without dropping labels", () => {
	const query =
		'renewal "signed proposal" from:client@example.com from:legal@example.com filename:terms.pdf in:inbox is:unread is:starred has:attachment after:2026-01-01 before:2026-02-01';
  const definition = definitionFromSearchView({
    query,
    searchParams: new URLSearchParams("label_id=label_vip"),
  });
  assert.equal(definition.filters.searchQuery, query);
  assert.equal(definition.filters.labelId, "label_vip");
	assert.equal(definition.filters.useDefaultSearchOrder, true);
	const appliedParams = savedViewSearchParams(definition);
	assert.deepEqual(appliedParams, {
		q: query,
		label_id: "label_vip",
	});
	assert.match(
		appliedSearchSql(appliedParams),
		/ORDER BY relevance DESC, e\.date DESC, e\.id ASC/,
	);
});

test("search views retain an explicitly selected sort through application", () => {
	const definition = definitionFromSearchView({
		query: "renewal",
		searchParams: new URLSearchParams(
			"sortColumn=sender&sortDirection=ASC",
		),
	});
	assert.equal(definition.filters.useDefaultSearchOrder, undefined);
	const appliedParams = savedViewSearchParams(definition);
	assert.deepEqual(appliedParams, {
		q: "renewal",
		sortColumn: "sender",
		sortDirection: "ASC",
	});
	assert.match(appliedSearchSql(appliedParams), /ORDER BY e\.sender ASC, e\.id ASC/);
});

test("unsupported sort values fail closed to deterministic date ordering", () => {
  assert.deepEqual(
    definitionFromFolderView({
      folder: "inbox",
      searchParams: new URLSearchParams(
        "sortColumn=body&sortDirection=SIDEWAYS",
      ),
    }).sort,
    { column: "date", direction: "DESC" },
  );
  assert.equal(
    savedViewRoute("support@example.com", "view/unsafe"),
    "/mailbox/support%40example.com/views/view%2Funsafe",
  );
});

test("saved views project the same row columns as folder lists", () => {
	// Saved View results run through buildMailSearchPlan exactly as search does
	// (app/queries/saved-views.ts posts to the same /search endpoint), so both
	// surfaces render EmailRow with the sender name and the paperclip intact.
	const sql = appliedSearchSql(
		savedViewSearchParams({
			filters: { folder: "inbox", labelId: "label_vip" },
			sort: { column: "date", direction: "DESC" },
		}),
	);
	assert.match(sql, /e\.sender_name/);
	assert.match(sql, /AS has_attachments/);
});
