# App Development Guide

This document covers the patterns all apps in this monorepo follow. Read it before generating or modifying any app.

## Runtime globals

The hub injects these globals into every app at runtime:

```js
const CONTEXT    = window.__CONTEXT_URL    ?? "";  // fetch family context (members, etc.)
const DB         = window.__DB_URL         ?? "";  // SQL database endpoint
const STORE      = window.__STORE_URL      ?? "";  // key-value store (older apps)
const FILES      = window.__FILES_URL      ?? "";  // file upload endpoint
const APP_ID     = window.__APP_ID         ?? "my-app";
const ME         = window.__CURRENT_MEMBER ?? null; // { id, name, role }
const EVENTS_URL = window.__EVENTS_URL     ?? "/api/events";
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

## hub-sdk.js

Import shared utilities from `/hub-sdk.js`:

```js
import { memberColor, initial, esc, isAdult, hubConfirm, formatRelativeDate } from "/hub-sdk.js";
```

- `memberColor(memberId, members)` — deterministic color string for a member's avatar
- `initial(name)` — first letter of a name for avatar display
- `esc(str)` — HTML-escape a string before injecting into innerHTML
- `isAdult(member, members)` — returns true if the member has role "adult"
- `hubConfirm({ message, description?, confirmLabel?, destructive? })` — async confirm dialog; returns true/false

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

## Parallelizing independent async calls

After a main write, `logActivity`, `notify`, and a data reload are independent — run them together:

```js
await db(`INSERT INTO items ...`);
await Promise.all([
  logActivity(id, "created", `...`),
  notify(`Title`, `Body`),
  loadItems(),
]);
closeModal();
render();
```

Never chain them sequentially with separate `await` calls — it adds 2–3× unnecessary latency.

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

## Base href

Every app sets `<base href="/run/{app-id}/">` in `<head>` so relative asset paths resolve correctly inside the hub iframe.

## Demo mode

When `DB` and `CONTEXT` are empty strings (local development or demo), the app should work with hardcoded demo data. Never crash or show an error when these are missing — show sample data instead.
