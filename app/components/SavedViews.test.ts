import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const save = readFileSync(
  new URL("./SaveCurrentViewButton.tsx", import.meta.url),
  "utf8",
);
const sidebar = readFileSync(
  new URL("./SavedViewsSidebarSection.tsx", import.meta.url),
  "utf8",
);
const results = readFileSync(
  new URL("../routes/saved-view-results.tsx", import.meta.url),
  "utf8",
);
const mailSidebar = readFileSync(
  new URL("./Sidebar.tsx", import.meta.url),
  "utf8",
);
const folderList = readFileSync(
  new URL("../routes/email-list.tsx", import.meta.url),
  "utf8",
);
const search = readFileSync(
  new URL("../routes/search-results.tsx", import.meta.url),
  "utf8",
);

test("saved views UI is personal, accessible, responsive, and manageable", () => {
  assert.match(save, /Only you can see this view/);
  assert.match(save, /Save current view/);
  assert.match(save, /role="alert"/);
  assert.match(save, /sm:flex-row/);
  assert.match(sidebar, /aria-labelledby="saved-views-heading"/);
  assert.match(sidebar, /Manage saved views/);
  assert.match(sidebar, /Rename/);
  assert.match(sidebar, /Delete/);
  assert.match(sidebar, /role="alert"/);
  assert.match(results, /Mailbox access required/);
  assert.match(results, /stays empty rather than showing unrelated mail/);
  assert.match(results, /role="alert"/);
  assert.match(mailSidebar, /<SavedViewsSidebarSection/);
  assert.match(folderList, /<SaveCurrentViewButton/);
  assert.match(search, /<SaveCurrentViewButton/);
});

test("opening a saved-view message marks it read like every other surface", () => {
  assert.match(results, /if \(!email\.read && mailboxId\)/);
  assert.match(results, /updateEmail\.mutate\(\{[\s\S]*?data: \{ read: true \}/);
});
