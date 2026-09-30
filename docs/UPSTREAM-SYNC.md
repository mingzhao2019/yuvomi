# Upstream synchronization

`custom` is a maintained product branch, not a thin fork. It shares the upstream
Yuvomi base, but several data models, routes, synchronization rules, and UI
surfaces are intentionally different. The detailed preservation checklist lives
in [`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md); use that file when a change touches
one of the areas below.

## Branch roles

- `main` is the upstream-compatible baseline and follows `upstream/main`.
- `custom` contains product-specific behavior and is used for development,
  deployment, and releases.
- `upstream` is the public Yuvomi remote used for review and fast-forwarding
  local `main`.
- `custom` must not be updated by replacing it wholesale with `upstream/main`.

## Custom boundaries

### Tasks and Microsoft To Do

- Task lists are persistent first-class objects. Preserve source/list identity,
  selected-list state, permissions, ordering, and deletion cleanup.
- Microsoft To Do synchronization keeps list mapping, incremental/full sync,
  recurrence, reminders, timezone conversion, and explicit user selection.
  Connecting an account must not silently enable or fully sync every list.
- Microsoft `steps`/`checklistItems` are not Yuvomi subtasks. Yuvomi subtasks
  have independent IDs, permissions, visibility, and parent relationships.
  Markdown checklists in task descriptions are a separate native feature.

### Calendars and subscriptions

- Preserve Outlook bidirectional sync, calendar selection, conflict handling,
  date windows, default reminders, and timezone semantics.
- Preserve Google, CalDAV, and ICS/WebCal behavior, including provider-specific
  reminders and the strict read-only boundary for ICS subscriptions.
- Do not treat provider accounts, calendar targets, VTODO lists, and event
  reminders as interchangeable settings or data.

### Notification channels

- Personal and household channels have separate configuration, permissions,
  templates, and recipient scopes. Do not merge their management paths.
- Preserve provider payload contracts, timezone-aware readable times, empty-field
  handling, trusted-link rules, and test-send behavior.

### Inventory and assets

- Assets use the existing Inventory API, database, permissions, visibility, and
  dashboard widgets. Do not introduce a second asset store or direct database
  access from the frontend.
- Preserve personal/household visibility, groups, cost calculations, dates,
  images, reminders, and the image-search workflow.

### API and UI contracts

- New or ported behavior must use the existing `/api/v1` contracts, permission
  checks, visibility rules, synchronization identity, and timezone handling.
- Preserve desktop and mobile layout slots, responsive interactions, list/detail
  behavior, search entry points, and the home dashboard widgets.
- Never resolve an overlap by selecting an entire file from `ours` or `theirs`.
  Combine behavior and remove only the specific incompatible fragment.

## Version and migration rules

- Read the release version from `main:package.json` after updating local `main`.
- Keep the root `package.json`, the two root version fields in
  `package-lock.json`, `public/sw.js`'s `APP_RELEASE`, and current release
  metadata synchronized.
- Do not modify historical `CHANGELOG.md` entries while updating current-release
  references.
- Database migrations are append-only. Never rewrite a released migration number,
  schema change, or historical behavior.
- A version mismatch is a release defect, not a browser-cache issue.

## Selective sync workflow

1. Confirm the worktree is clean, inspect branch topology, and verify the
   `origin` and `upstream` URLs. Never hide or discard unexplained work.

2. Refresh upstream and update only local `main` by fast-forward:

   ```bash
   git fetch upstream
   git switch main
   git merge --ff-only upstream/main
   git rev-parse main upstream/main
   ```

   The two hashes must match. If fast-forwarding is not possible, stop and
   resolve the divergence explicitly. Do not reset, rebase, or force-update
   `main`.

3. Create a dated integration branch from the current `custom` branch:

   ```bash
   git switch custom
   git switch -c custom-upstream-selective-YYYY-MM-DD
   ```

   If that branch already exists, inspect its ownership and state. Do not reuse
   an unknown branch.

4. Review every upstream commit in order. Classify each change as a correctness
   or security fix, independent feature, coupled feature, duplicate, or truly
   unnecessary change. Cherry-pick only genuinely independent commits. Port
   coupled changes manually and preserve the custom contracts above.

5. For each overlap, check migrations, API fields and errors, permissions,
   visibility, sync identity, conflicts, timezones, reminders, and desktop/mobile
   behavior. Record the decision and affected behavior in the integration commit
   or the current sync record; do not silently drop a fragment.

6. Validate on the integration branch before merging it into `custom`:

   ```bash
   git diff --check
   git diff --stat custom...HEAD
   git log --oneline --decorate custom..HEAD
   npm test
   ```

   Also run focused tests for affected modules, check version consistency, and
   explicitly confirm task lists, Microsoft To Do, Outlook/ICS calendars,
   notification channels, assets, and dashboard widgets remain intact.

7. After validation, fast-forward `custom` and remove the temporary branch:

   ```bash
   git switch custom
   git merge --ff-only custom-upstream-selective-YYYY-MM-DD
   git branch -d custom-upstream-selective-YYYY-MM-DD
   ```

   Pushes, force-pushes, remote branch deletion, deployment, and permission
   changes require explicit authorization. Never use a force push to repair a
   failed synchronization.

## Current sync checkpoint

As of 2026-09-30, local `main` and `upstream/main` both point to
`e9426e434` (v2.71.0). The previous custom checkpoint was `8d9c41277`.
Every upstream commit after that checkpoint was reviewed in order and adopted
on `custom-upstream-selective-2026-09-30`; upstream was not merged wholesale
into `custom`.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `fe481849c` (#1575) | Refreshes the site screenshots and documents wall mode. | Adopted as `fe481849c`; documentation/assets only. |
| `c6e17e0ca` (#1576) | Reorganizes the README's family/module sections and corrects claims against the app. | Adopted as `c6e17e0ca`; checked the README and landing-page consistency tests. |
| `5675c95e7` (#1530, #1552) | CLI restore refuses to run while a server is using the database; server startup coordinates through the instance lock. | Adopted as `5675c95e7`; composed with the existing restore gate and kept the lock handshake process-local. |
| `c44663b33` (#1577, #1579) | Recipe edit/delete authorization follows `meals: write`, while provider-mirrored recipes remain read-only. | Adopted as `c44663b33`; replaced the old recipe-owner check with the module permission gate, retained mirror protection and `meals: read` denial, and added route/gate coverage. |
| `1721e9025` (#1578) | Housekeeping tests use the household date; installer weather guidance names the current settings path. | Adopted as `1721e9025`; no custom data contract changed. |
| `38ad18ea1` (#1035, #1541) | Separates a recurring budget series definition from its first booking so later-series edits do not rewrite historical transactions. | Adopted as `38ad18ea1`; migration 238 is additive and preserves anchor identity, responsibility assignments, visibility, and existing recurrence fields. |
| `7faa88992` (#1581) | Gives the off-switch track 3:1 contrast and mirrors its motion in RTL. | Adopted as `7faa88992`; uses the dedicated switch token and retains the existing responsive control layout. |
| `de60e3dc3` (#1584) | Keeps the weather dashboard tile present with an unavailable state when a configured provider fails. | Adopted as `de60e3dc3`; distinguishes provider failure from `not_configured` and preserves the widget slot and retry path. |
| `cc82934a4` (#1582) | Removes the unwanted surface strip below the tab bar in installed iPhone PWA mode. | Adopted as `cc82934a4`; retained the existing mobile navigation and safe-area behavior. |
| `6aa172cb4` (#1437) | Adds Brazilian Portuguese for the app, web installer, and CLI. | Adopted as `6aa172cb4`; manually translated remaining long app strings and removed duplicate dashboard keys from 20 locale files. |
| `77434ee75` (#1586) | Documents rootless Podman without an outbound route and the bridge setup fix. | Adopted as `77434ee75`; installer behavior and existing deployment paths remain intact. |
| `5a15a11dd` | Publishes v2.71.0 release metadata. | Adopted as `5a15a11dd`; root package, both root lockfile versions, service-worker release, and current release metadata agree on `2.71.0`. |
| `df353de8e` | Aligns `DESIGN.md` with v2.71.0 wall-mode, contrast, selected-row, and weather behavior. | Cherry-picked as `3c5121aa4`; documentation only. |
| `e9426e434` | Resolves three stale `DESIGN.md` rules and corrects the calendar week-block tint comment. | Cherry-picked as `20f8d6ccc`; the CSS change is comment-only, with no runtime behavior change. |

Semantic overlaps were resolved explicitly. The restore change acquires the
instance lock before database recovery or cleanup: the server waits, while the
CLI refuses an active server, without changing the existing restore protocol.
For recipes, the previous owner-only rule was not a required custom boundary;
the household-wide `meals: write` contract was adopted, while mirrored recipes
still reject edits/deletes and the module gate still rejects `meals: read`.
Migration 238 adds a series-definition table and responsible-assignment table,
backfills only missing definitions, and installs insert/start/stop triggers;
it does not rewrite released migrations. The definition carries the existing
visibility values, including `shared_amount`, and leaves the first booking as
an ordinary transaction. Weather failures remain visible as an unavailable
widget instead of being mistaken for a disabled module. The pt-BR import's
incomplete long strings were translated, duplicate dashboard keys were
removed, and custom `#1358` permission notes remain under `[Unreleased]` rather
than being moved into the v2.71.0 release.

The earlier dashboard fix `708df9e61` remains intact: completed calendar events
in the overview render `event-item--done`, CSS applies line-through, and
`test/test-dashboard-today.js` asserts the completed state. No upstream change
in this range superseded it.

The schema is migration `238`; the migration append-only test passes. The root
package, both root lockfile version fields, `public/sw.js`'s `APP_RELEASE`, and
current release metadata match `main:package.json` at `2.71.0`.

Focused validation passed for instance locking, budget migration and routes,
recipes and module permissions, weather, dashboard (including the archived
event line-through state), housekeeping, installer localization/static/a11y,
PWA precache, i18n, migration append-only behavior, README/landing consistency,
and the frontend audit. The full `npm test` completed with exit code 0 before
the final two documentation-only cherry-picks. After those cherry-picks, the
frontend audit passed 434/434, the mobile-chrome suite passed, the dashboard
overview regression passed 20/20, and `git diff --check` passed. The budget
browser test could not run because Chrome 152 is not installed. The restore-swap
suite reported 64 passed, 3 skipped for root-specific filesystem behavior, and
0 failed.

Microsoft To Do task/list mapping, Outlook and ICS calendar semantics,
persistent task lists, personal and household notification channels,
Inventory/assets, and dashboard widgets remain present with their custom
semantics; their code was not removed or replaced. No push was performed.
