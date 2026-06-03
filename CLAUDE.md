# App Development Guide

This document covers the patterns all apps in this monorepo follow. Read it before generating or modifying any app.

## Runtime globals

The hub injects these globals into every app at runtime:

```js
const CONTEXT         = window.__CONTEXT_URL    ?? "";  // fetch family context (members, etc.)
const DB              = window.__DB_URL         ?? "";  // SQL database endpoint (storage:"db" apps only)
const STORE           = window.__STORE_URL      ?? "";  // key-value store
const FILES           = window.__FILES_URL      ?? "";  // file upload endpoint
const DOCS            = window.__DOCS_URL       ?? "";  // hub-native document storage (see below)
const CROSS_WRITE_URL = window.__CROSS_WRITE_URL ?? ""; // cross-app writes (hub-sdk crossWrite uses this)
const APP_ID          = window.__APP_ID         ?? "my-app";
const ME              = window.__CURRENT_MEMBER ?? null; // { id, name, role }
const EVENTS_URL      = window.__EVENTS_URL     ?? "/api/events";
```

`ME` is null in demo mode (no logged-in user). Always guard against it.

## DB helper

Every app that uses SQL defines this helper:

```js
async function db(sql, params = []) {
  if (!DB) return { rows: [] };
  const res = await fetch(DB, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  return res.json(); // { rows: [...] }
}
```

Schema is managed by hub migrations in `migrations/001_init.sql` — do not run `CREATE TABLE` at runtime.

Every table that stores per-household data **must** declare `household_id` as `UUID`, not `TEXT`:

```sql
household_id UUID NOT NULL DEFAULT current_setting('app.household_id', true)::uuid,
```

Using `TEXT` causes a Postgres type error (`operator does not exist: text = uuid`) when the hub queries app storage usage, and breaks row-level security policies that compare the column as a uuid.

## hub-sdk.js

Import shared utilities from `/hub-sdk.js`:

```js
import { memberColor, initial, esc, isAdult, hubConfirm, formatRelativeDate, fmtMoney, fmtMoneyShort } from "/hub-sdk.js";
```

- `memberColor(memberId, members)` — deterministic color string for a member's avatar
- `initial(name)` — first letter of a name for avatar display
- `esc(str)` — HTML-escape a string before injecting into innerHTML
- `isAdult(member, members)` — returns true if the member has role "adult"
- `hubConfirm({ message, description?, confirmLabel?, destructive? })` — async confirm dialog; returns true/false
- `fmtMoney(cents)` — format integer cents as USD with no decimals: `fmtMoney(125000)` → `"$1,250"`. Returns `"—"` for null.
- `fmtMoneyShort(cents)` — compact format for large amounts: `$450K`, `$1.3M`. Use for summary displays.

Always use `esc()` when rendering user-provided strings into HTML templates.

## Loading members

```js
async function loadMembers() {
  if (!CONTEXT) {
    members = [/* demo fallback */];
    return;
  }
  try {
    const res = await fetch(`${CONTEXT}?keys=family.members`);
    members = ((await res.json())["family.members"]) ?? [];
  } catch { members = []; }
}
```

## Notifications

```js
async function notify(title, body) {
  await fetch("/api/notifications/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, url: `/run/${APP_ID}` }),
  }).catch(() => {});
}
```

Always `.catch(() => {})` — notifications are best-effort.

## Activity log

Many apps log user actions to an `activity` table:

```js
async function logActivity(recordId, action, detail = "") {
  const id = crypto.randomUUID();
  await db(
    `INSERT INTO activity (id, record_id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, recordId, ME?.id ?? "system", action, detail, new Date().toISOString()]
  );
}
```

## Optimistic local state updates

After a main DB write succeeds, update local state immediately and re-render — do **not** reload from the database. A reload adds a full round-trip before the user sees any feedback.

```js
async function createItem(fields) {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  // 1. Write to DB
  await db(`INSERT INTO items (id, title, created_at) VALUES (?, ?, ?)`, [id, fields.title, now]);

  // 2. Update local state and render immediately
  items = [{ id, title: fields.title, created_at: now, status: "active" }, ...items];
  closeModal();
  render();

  // 3. Fire side effects in the background — don't block the UI
  Promise.all([
    logActivity(id, "created", `${ME.name} created "${fields.title}"`),
    notify(`New item: ${fields.title}`, `${ME.name} added a new item.`),
    fetch("/api/activity", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "item_created", actor: ME.name,
        description: `${ME.name} created "${fields.title}"`,
        metadata: { deepLink: { appId: APP_ID, params: { itemId: id } } } }),
    }).catch(() => {}),
  ]).catch(() => {});
}
```

For updates and deletes, patch the array in-place:

```js
// update
const idx = items.findIndex(i => i.id === id);
if (idx !== -1) items[idx] = { ...items[idx], title: fields.title, updated_at: now };

// delete
items = items.filter(i => i.id !== id);
```

Never re-fetch the full list from the DB just to reflect a change you already know about.

## Member lookup map

Build a `Map` once after `loadMembers()` completes. Use it everywhere instead of `.find()` — avoids an O(n) scan on every card render.

```js
let members   = [];
let memberMap = new Map();

async function loadMembers() {
  if (!CONTEXT) {
    members = [{ id: "demo-1", name: "Alex", role: "adult" }, /* … */];
    memberMap = new Map(members.map(m => [m.id, m]));
    return;
  }
  try {
    const res = await fetch(`${CONTEXT}?keys=family.members`);
    members = ((await res.json())["family.members"]) ?? [];
  } catch { members = []; }
  memberMap = new Map(members.map(m => [m.id, m]));
}

// Use map lookups everywhere — not .find()
function memberName(id) { return memberMap.get(id)?.name ?? "Unknown"; }
```

## Parallelizing independent async calls

`loadMembers()` and `loadItems()` are independent — run them in parallel at startup:

```js
(async () => {
  await Promise.all([loadMembers(), loadItems()]);
  render();
  handleDeepLink();
})();
```

Side effects like `logActivity`, `notify`, and `/api/activity` are also independent of each other — batch them in a fire-and-forget `Promise.all` after the UI has already updated (see optimistic local state above). Never chain them sequentially with separate `await` calls.

## Modal pattern

Most apps use a single `modalEl` variable:

```js
let modalEl = null;
function openModal(html) {
  closeModal();
  modalEl = document.createElement("div");
  modalEl.className = "modal-backdrop";
  modalEl.innerHTML = `<div class="modal">${html}</div>`;
  modalEl.addEventListener("click", e => { if (e.target === modalEl) closeModal(); });
  document.body.appendChild(modalEl);
}
function closeModal() { modalEl?.remove(); modalEl = null; }
```

## Loading state on submit buttons

Any async submit handler must disable its button immediately so the user knows work is in progress:

```js
window.submitForm = async function(existingId) {
  // 1. validate first — bail before touching UI
  const name = document.getElementById("f-name").value.trim();
  if (!name) { document.getElementById("f-name").focus(); return; }

  // 2. disable the button
  const btn = modalEl?.querySelector('.modal-actions .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  // 3. do async work — on success, closeModal() removes the button from DOM
  try {
    await saveRecord({ name });
    closeModal();
    render();
  } catch (e) {
    // restore so user can retry
    if (btn) { btn.disabled = false; btn.textContent = existingId ? 'Save' : 'Create'; }
    throw e;
  }
};
```

For buttons outside a modal (e.g. an inline Add button), find them directly:

```js
const btn = document.querySelector('.add-btn');
if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
await addItem(val);
if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
```

## Hub CSS variables

Apps inherit these CSS custom properties from the hub theme at runtime:

```css
--hub-bg           /* page background */
--hub-surface      /* card/panel background */
--hub-border       /* default border color */
--hub-text         /* primary text */
--hub-text-muted   /* secondary/muted text */
--hub-primary      /* accent color (buttons, links) */
--hub-primary-fg   /* foreground on accent color */
--hub-primary-hover
--hub-radius       /* border-radius for cards/buttons */
--hub-font-size    /* base font size */
--hub-font         /* font-family */
```

Always define fallback values: `var(--hub-bg, #f9fafb)`.

## Deep linking

The hub can open an app at a specific item by appending query params to the iframe URL. Apps that support deep linking should read those params on startup and navigate to the referenced item.

### Handling incoming deep-link params

Read `window.location.search` during init and navigate to the referenced item if params are present:

```js
function handleDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const pollId = params.get("pollId");
  if (pollId) openPoll(pollId);
}

(async () => {
  await Promise.all([loadMembers(), loadItems()]);
  handleDeepLink(); // after data is loaded so the item exists
  render();
})();
```

Pick param names that are specific to your app (e.g. `pollId`, `taskId`, `recipeId`). The hub passes whatever params were in the link — there is no shared namespace.

### Navigating to another app with params

Use the `hub:open` postMessage to send the user to a specific item in another app:

```js
window.parent.postMessage({
  type: "hub:open",
  appId: "grocery",
  params: { listId: "abc123" },
}, "*");
```

The hub navigates to `/open/grocery?listId=abc123`, which passes `?listId=abc123` into the grocery app's iframe.

### Logging activity with a deep link

When you log hub-level activity (via `/api/activity` or a hub SDK helper), include a `deepLink` in the metadata so the activity item and notification bell become clickable links:

```js
await fetch("/api/activity", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "poll_created",
    description: `${ME.name} created a new poll: "${title}"`,
    metadata: {
      deepLink: {
        appId: APP_ID,
        params: { pollId: id },
      },
    },
  }),
}).catch(() => {});
```

The hub renders that activity entry as a link to `/open/{appId}?pollId={id}`. Without `deepLink`, the entry is plain text.

## Events API

Publish cross-app events other apps can consume:

```js
await fetch(EVENTS_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    source_app_id: APP_ID,
    type: "event.type",       // e.g. "allowance.weekly"
    subject_id: memberId,
    payload: { /* ... */ },
  }),
}).catch(() => {});
```

## File uploads

Use `createFilesHelper` from `/hub-sdk.js` for all file operations. It handles correct URL construction, upload error detection, and deletion — do not roll your own `fetch` calls against `FILES`.

```js
import { createFilesHelper } from "/hub-sdk.js";
const files = createFilesHelper(window.__FILES_URL ?? "");
```

**Upload** — resolves with `{ id, url }` or throws on any server error (wrong MIME type → 415, too large → 413, storage limit → 507). Never insert a DB record until `upload()` resolves successfully.

```js
async function uploadFile(file) {
  const { id: fileId, url: fileUrl } = await files.upload(file);
  // now safe to insert into your DB
}
```

**Delete** — takes the file ID (not a URL):

```js
await files.delete(fileId).catch(() => {});
```

**List** — returns `{ files, totalBytes, limit }`:

```js
const { files: fileList, totalBytes, limit } = await files.list();
```

**Get a file URL** — for linking or displaying:

```js
const url = files.url(fileId);  // e.g. /run/{app-id}/api/files/{id}
```

**Show the upload area only when files are available** (guard against demo mode):

```js
const uploadHtml = window.__FILES_URL ? `<div class="upload-area">…</div>` : "";
```

Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx), `text/plain`, `text/markdown`.

## Hub-native document storage

For documents that should persist in the hub (survive app reinstall, appear in the household document library, respect encryption at rest), use `window.__DOCS_URL` instead of — or alongside — your own app DB.

```js
const DOCS = window.__DOCS_URL ?? "";
```

**Create** — POST a document record. `fileKey` is the ID returned by `files.upload()`.

```js
const { id } = await fetch(DOCS, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title:    file.name,           // required
    category: "home",              // required: medical | legal | home | financial | other
    fileKey:  uploadResult.id,     // from files.upload()
    mimeType: file.type,
    sizeBytes: file.size,
    sourceId: itemId,              // optional: link to your own entity (e.g. a maintenance item)
    folder:   "Warranties",        // optional: freeform grouping label
    sharedWith: ["everyone"],      // optional: [] = owner-only, ["everyone"] = whole household
  }),
}).then(r => r.json());
```

**List** — GET with optional filters:

```js
const docs = await fetch(`${DOCS}?sourceId=${itemId}`).then(r => r.json());
// also: ?folder=Warranties
```

**Delete** — DELETE by document ID (also delete the associated file):

```js
await fetch(`${DOCS}/${docId}`, { method: "DELETE" });
await files.delete(doc.fileKey).catch(() => {});
```

Hub documents are automatically deleted when the app is uninstalled. Storage usage counts against the app's `max_docs_bytes` limit (default 100 MB). Guard against demo mode:

```js
const uploadHtml = window.__DOCS_URL ? `<div class="upload-area">…</div>` : "";
```

## Cross-app data sharing

Apps can read and write each other's KV store data. Both sides must declare intent in their manifests; the hub enforces both at runtime.

### Exposing data to other apps

Declare the KV keys you want to make readable (or writable) by other apps:

```json
{
  "exports": ["recipes", "pending_items"]
}
```

Export key names must be lowercase alphanumeric, hyphens, or underscores.

### Reading another app's exported key

Declare the key in `data_access.reads` using the pattern `app.{appId}.{key}`:

```json
{
  "data_access": {
    "reads": ["family.members", "app.recipes.recipes"],
    "writes": []
  }
}
```

Then fetch it the same way as any context key:

```js
const res = await fetch(`${CONTEXT}?keys=app.recipes.recipes`);
const data = await res.json();
const recipes = data["app.recipes.recipes"] ?? [];
```

The hub returns the parsed JSON value of the source app's KV entry for that key. Returns `null` if the key hasn't been written yet.

### Writing to another app's exported key

Declare the key in `data_access.writes`:

```json
{
  "data_access": {
    "reads": [],
    "writes": ["app.grocery.pending_items"]
  }
}
```

Then use `crossWrite` from `/hub-sdk.js`:

```js
import { crossWrite } from "/hub-sdk.js";

await crossWrite("grocery", "pending_items", [
  { op: "array_append", path: "items", value: { name: "Flour", addedBy: "Meal Planner" } },
  { op: "array_append", path: "items", value: { name: "Eggs",  addedBy: "Meal Planner" } },
]);
```

`crossWrite` uses the same patch ops as the KV store PATCH endpoint: `array_append`, `array_remove`, `set`, `increment`, `delete`. The `path` is a dotted path within the JSON blob stored at the key.

Writes count against the **calling** app's daily write quota, not the target app's.

### The inbox pattern (for `storage: db` apps)

DB-storage apps can't receive writes directly into their SQL schema. Instead, expose a KV key as an inbox, then drain it on load:

```js
async function processPendingInbox() {
  if (!STORE) return;
  try {
    const res = await fetch(`${STORE}?key=pending_items`);
    if (!res.ok) return;
    const { value } = await res.json();
    if (!value) return;
    const pending = JSON.parse(value).items ?? [];
    if (!pending.length) return;

    for (const item of pending) {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) continue;
      await db(`INSERT INTO items (...) VALUES (...)`, [...])
        .catch(() => {}); // silently ignore duplicates
    }

    await fetch(`${STORE}?key=pending_items`, { method: "DELETE" });
  } catch { /* non-fatal */ }
}
```

Call it during init before loading your main data:

```js
(async () => {
  await loadMembers();
  await processPendingInbox(); // drain inbox first
  await loadItems();
  render();
})();
```

The inbox key must be listed in `exports`. Keep inbox processing non-fatal — always wrap in try/catch and never let it block the app from loading.

### Permission escalation

When an app update **adds** new cross-app reads, writes, or exports, the hub automatically queues the update for admin approval even if `requires_approval` is `false` in the manifest. The admin will see a callout in the update review screen explaining what new access was added.

## Resource limits

The hub injects current limits into `window.__RESOURCE_LIMITS`:

```js
const LIMITS = window.__RESOURCE_LIMITS ?? {};
// LIMITS.max_file_bytes      — max bytes per individual upload (default 10 MB)
// LIMITS.max_files_bytes     — max total file storage for this app (default 500 MB)
// LIMITS.max_db_bytes        — max DB storage for this app (default 200 MB)
// LIMITS.max_store_bytes     — max KV storage for this app
// LIMITS.max_store_reads_per_day
// LIMITS.max_store_writes_per_day
```

Apps do not need to enforce these limits themselves — the hub enforces them and returns 507 when exceeded. But apps may read them to display a storage bar or warn the user before an upload.

## Nav label

Every app must include a `nav` field in `manifest.json` so it appears in the hub's left navigation by default:

```json
"nav": { "label": "My App" }
```

Use a short label (1–2 words). Never omit this field — apps without it are invisible in the nav until an admin manually enables them.

## Base href

Every app sets `<base href="/run/{app-id}/">` in `<head>` so relative asset paths resolve correctly inside the hub iframe.

## Extracting testable logic

Apps with non-trivial pure logic should extract it into `src/logic.js` so it can be unit-tested without a browser environment.

**Pattern:**

1. `src/shared.js` — mirrors any `hub-sdk.js` functions used by logic (e.g. `isAdult`, `esc`). Tests import from here instead of the browser-only SDK.

2. `src/logic.js` — exports pure functions. Import from `shared.js`, not `/hub-sdk.js`:

```js
import { isAdult } from "./shared.js";
export { isAdult };

export function canSeeItem(item, me) {
  if (isAdult(me)) return true;
  return item.visibility === "public";
}
```

3. `src/index.html` — imports from both `/hub-sdk.js` (browser globals) and `./logic.js` (pure functions). Use aliased imports to avoid shadowing if you wrap them with local state:

```js
import { esc, isAdult, hubConfirm } from "/hub-sdk.js";
import { canSeeItem as _canSeeItem } from "./logic.js";

// thin wrapper that binds to app state
function canSeeItem(item) { return _canSeeItem(item, ME); }
```

4. `__tests__/logic.test.mjs` — imports from `../src/logic.js`. No DOM, no mocks needed for pure functions.

**When to extract logic:**
- Access control checks (who can see/edit/vote)
- Derived status or computed values from raw data
- Non-trivial filtering or sorting
- Date/money formatting with edge cases

**When not to:** DB calls, render functions, event handlers, and anything that closes over module-level state belong in the HTML script and don't need extraction.

## Demo mode

When `DB` and `CONTEXT` are empty strings (local development or demo), the app should work with hardcoded demo data. Never crash or show an error when these are missing — show sample data instead.

## Security constraints

### Migration SQL

Migrations run on the shared hub database. The hub validates and rejects any migration that contains:

- `CREATE FUNCTION` / `CREATE PROCEDURE` / `CREATE TRIGGER` — not allowed; the hub manages all database functions
- `SECURITY DEFINER` — not allowed; privilege escalation risk
- `GRANT` / `REVOKE` — not allowed; the hub manages role permissions
- `CREATE POLICY` / `DROP POLICY` — not allowed; the hub applies row-level security after migrations
- `CREATE EXTENSION` / `CREATE ROLE` / `ALTER ROLE` / `CREATE SCHEMA` — system-level, not allowed
- `CREATE FOREIGN` / `CREATE SERVER` — not allowed; foreign data wrappers are a data exfiltration risk
- `COPY` — not allowed; file system access
- `public.` qualified names (e.g. `public.family_members`) — not allowed; use unqualified names instead
- `SET ROLE` / `SET SESSION AUTHORIZATION` — not allowed

Migrations must be additive only (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). The hub enforces RLS on every table after migrations run — do not attempt to manage it yourself.

### App JavaScript

- Always use `esc()` from `/hub-sdk.js` when injecting any user-provided string into `innerHTML`. Never use raw string interpolation with user data in HTML templates.
- Never construct SQL strings from user input — always use parameterized queries via the `db()` helper with the `params` array.
- The `DB` endpoint only runs queries against your app's own schema. You cannot query other apps' tables or hub tables — this is enforced at the database level.
- Do not attempt to read or write `window.__CONTEXT_URL`, `window.__DB_URL`, or other hub globals from another origin — the iframe sandbox blocks it.

### CDN whitelist

`cdn_whitelist` entries in the manifest must be `https://` origins only (e.g. `"https://cdn.jsdelivr.net"`). No paths, no wildcards, no `http://`. The hub rejects manifests with invalid entries and strips any that bypass validation at CSP-build time.

## AI access (MCP)

Apps are **invisible to AI clients by default**. Opt in explicitly — this is intentional: private apps (couples apps, therapy notes, etc.) should never appear in AI tool listings.

Add `ai_access` to your manifest to enable MCP access:

```json
{
  "ai_access": {
    "allowed": true,
    "mode": "read"
  }
}
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `allowed` | boolean | `false` | Master switch. Must be `true` for any MCP access. |
| `mode` | `"read"` \| `"read_write"` | `"read"` | `"read"` allows `get_app_data` only. `"read_write"` also allows `set_app_data`. |
| `db_exports` | `string[]` | `[]` | Named SELECT queries exposed via `query_app_db`. DB-storage apps only. |
| `db_mutations` | `string[]` | `[]` | Named UPDATE mutations exposed via `mutate_app_db`. UPDATE-only, no INSERT or DELETE. DB-storage apps only. |
| `db_inserts` | `string[]` | `[]` | Named INSERT operations exposed via `insert_app_db`. Each requires a JSON Schema file for param validation. DB-storage apps only. |
| `requires_admin_approval` | boolean | `false` | If true, the hub admin must explicitly grant AI access after install. |

### KV apps — reading and writing via MCP

With `allowed: true` and `mode: "read"`, an AI client can read any key from your app's KV store via the `get_app_data` tool. With `mode: "read_write"`, it can also write via `set_app_data`.

```json
{
  "ai_access": {
    "allowed": true,
    "mode": "read_write"
  }
}
```

KV access goes through the normal MCP tool layer — no additional app-side work needed.

### DB apps — named query exports

DB-storage apps cannot be queried with raw SQL via MCP. Instead, declare named SELECT queries in `ai_access.db_exports` and put the SQL files in `src/queries/`:

```json
{
  "storage": "db",
  "ai_access": {
    "allowed": true,
    "mode": "read",
    "db_exports": ["open_tasks", "overdue_tasks", "task_summary"]
  }
}
```

Each name maps to `src/queries/{name}.sql`. The build script includes everything under `src/` in the bundle, so these files are automatically packaged and served.

**Query file conventions:**

- Files must be `SELECT` or `WITH ... SELECT` statements — the hub rejects anything else
- Always filter by `household_id` explicitly — do not rely on default values alone:
  ```sql
  WHERE household_id = current_setting('app.household_id', true)::uuid
  ```
- Include `LIMIT` to bound result size
- The query runs under the `hub_app_executor` Postgres role with `search_path` set to your app's schema — unqualified table names resolve to your schema, not hub tables
- No parameterized inputs — named queries are fixed SELECT statements with no user-supplied values

Example (`src/queries/open_tasks.sql`):

```sql
SELECT
  t.id,
  t.title,
  t.assignee_id,
  t.due_date,
  t.priority,
  l.name AS list_name
FROM tasks t
LEFT JOIN lists l
  ON l.id = t.list_id
  AND l.household_id = t.household_id
WHERE t.household_id = current_setting('app.household_id', true)::uuid
  AND t.completed = 0
ORDER BY t.due_date NULLS LAST, t.priority DESC
LIMIT 200
```

### DB apps — named INSERT operations

AI INSERT access requires an additional validation layer because the AI client supplies the data values. Each named insert has two bundle files:

**`src/inserts/{name}.sql`** — the INSERT SQL. User-supplied params use `$1`, `$2`, etc. System values are generated by SQL built-ins — never rely on the AI client to supply IDs, household_id, or timestamps:

```sql
INSERT INTO items (
  id, household_id, name, name_normalized, added_by_name, created_at
) VALUES (
  gen_random_uuid()::text,
  current_setting('app.household_id', true)::uuid,
  $1,
  lower(trim($1)),
  'AI',
  NOW()::text
)
ON CONFLICT (household_id, name_normalized) DO NOTHING
```

**`src/schemas/{name}.json`** — JSON Schema (draft-07) describing the user-supplied params array. The hub validates params against this schema before executing the SQL:

```json
{
  "type": "array",
  "items": [
    { "type": "string", "minLength": 1, "maxLength": 200, "description": "item name" }
  ],
  "minItems": 1,
  "maxItems": 1
}
```

Declare in the manifest:
```json
"ai_access": {
  "allowed": true,
  "mode": "read_write",
  "db_inserts": ["add_item"]
}
```

**Migration constraints are your second validation layer.** JS validation in the app front-end enforces business rules at runtime, but AI inserts bypass the front-end. Move those constraints into the DB so both paths enforce them:

```sql
-- In a migration: add constraints that the front-end currently enforces in JS
ALTER TABLE items ADD CONSTRAINT items_name_len CHECK (length(name) > 0) IF NOT EXISTS;
ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check CHECK (priority BETWEEN 0 AND 3) IF NOT EXISTS;
ALTER TABLE tasks ADD CONSTRAINT tasks_list_fk FOREIGN KEY (list_id) REFERENCES lists(id) IF NOT EXISTS;
```

**SQL file rules (enforced by hub at runtime and tested by CI):**
- Must start with `INSERT`
- Must contain `household_id` (set via `current_setting()`, never from params)
- User params are positional (`$1`, `$2` — max 50)
- System values always come from SQL built-ins: `gen_random_uuid()`, `current_setting()`, `NOW()`
- Include `ON CONFLICT DO NOTHING` or `DO UPDATE` where duplicates are possible

**Schema file rules:**
- Must be valid JSON Schema (draft-07)
- Use `items` (array form) for tuple/positional validation, not `prefixItems`
- Declare `minItems` and `maxItems` to match the SQL param count
- Add format constraints (`pattern`, `minLength`, `maxLength`, `minimum`, `maximum`) to catch bad input before it reaches the DB

### Privacy and admin overrides

- Apps with no `ai_access` field (or `allowed: false`) are completely invisible to MCP clients — they do not appear in `list_apps` results and their data cannot be accessed
- A hub admin can set `disabled: true` via `PATCH /api/apps/{id}/ai-access` to block MCP access for any app regardless of its manifest
- Admins cannot *enable* AI access for an app that declared `allowed: false` — only the manifest can grant it
- Consider whether your app contains sensitive content before enabling `ai_access`. Couples apps, therapy journals, and similar private apps should leave `allowed: false`
