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

As of 2026-09-29, local `main` and `upstream/main` both point to
`c46f8724f` (#1568), following the previous checkpoint `40880779b` (#1533).
The updates below were reviewed in upstream order and selectively ported on
`custom-upstream-selective-2026-09-29`; `upstream/main` was not merged into
`custom`.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `0a5aa8af5` (#1535) | CalDAV credentials are required again after changing server or username. | Ported; retained account identity and credential boundaries. |
| `7048cf2f7` (#1534/#1538) | Dashboard's “due today until” follows the household day. | Ported; retained custom dashboard composition. |
| `75205a48e` (#1531/#1537) | Restore-route coverage includes `/docs` and every top-level route. | Ported with the existing route allowlists. |
| `fe63eb995` (#1532/#1548) | Restore waits for work that writes after the HTTP response. | Ported with custom deferred-provider-sync tracking. |
| `b72eb1982` (#1536) | Split dashboard tile net matches its summary band. | Test-only change adopted. |
| `fd45aec4e` (#1546/#1553) | Editing a recurring budget month for future entries no longer ends the series. | Ported with custom recurring-series behavior. |
| `93bdaa890` (#1539/#1542) | Medication reminders use the household clock. | Ported; no data-model change. |
| `450885975` (#1540/#1543) | Editing a housekeeping visit preserves its household day. | Ported with household-time-zone semantics. |
| `3a6fc78d7` (#1555) | WebDAV credentials are required again after changing server or username. | Ported; existing account and secret handling retained. |
| `0a544860f` (#1473/#1547) | Counting strings receive locale-appropriate plural categories. | Manually composed across locales; custom translations retained and plural categories checked. |
| `7349c8081` (#1549/#1554) | `_one` strings retain `{{count}}` where “one” can cover values above one. | Manually composed across locales; custom wording retained. |
| `58eaf7558` (#1556/#1557) | Housekeeping check-in uses the household day. | Ported with household-time-zone semantics. |
| `740d28d95` (#1544/#1558) | Copy explains that deleting a series' first budget entry ends the series. | Ported as explanatory copy; deletion behavior was not changed. |
| `e69964d5c` (#1474) | Multi-day calendar bars mirror their open edge and tint in RTL. | Ported; calendar selection and completion behavior retained. |
| `c816176bc` (#1551/#1563) | Restore waits for GET handlers that write after an `await`. | Ported; To Do list refresh is gated, and Inventory image-search GETs are documented as read-only. |
| `2de082470` (#1564) | Wall mode has an in-view exit and Back leaves the mode. | Adopted with the shared overlay-history marker; custom wall timer and route behavior retained. |
| `6de301ee7` (#1565) | RTL calendar class lookup escapes every regular-expression character. | Equivalent test fix was already present as `7c72feb1c`; no duplicate port was added. |
| `1c607f539` (#1567) | First-run setup keeps the selected language and accepts an optional time zone. | Ported as additive `/api/v1` fields; custom `test-chain` was preserved and the new test added to it. |
| `c46f8724f` (#1568) | Admin weather settings report whether the active source is the database or server environment. | Ported with one shared resolver; `weather_user` stays member-scoped, and the API response excludes keys. |

Semantic overlaps were resolved explicitly. The two pluralization changes were
merged into all locales without replacing custom copy. Wall mode uses the
existing single overlay-history registry and keeps the custom timer and
root-route lifecycle. Setup writes language/time zone in the first-admin
transaction and does not infer region, currency, or date format. Weather
resolution is shared by the proxy and preferences response; removing a stored
Open-Meteo location clears its coordinates so environment configuration can
apply again. Restore gating protects database-writing provider refreshes while
keeping network-only image search outside the gate. No migrations or released
schema history changed.

The preceding Inventory port `e146829b3` (#1257) remains append-only migration
`236`, alongside custom migration `224`; it supplies recurring tracked dates,
service history, and odometer fields while preserving custom asset scope,
visibility, assignment, and administrator boundaries. The current schema
migration remains `237`.

`main:package.json` remains at `2.69.1`; the root package, both root lockfile
versions, and `public/sw.js`'s `APP_RELEASE` match it. Current installation and
landing-page metadata also remain on `2.69.1`; historical changelog entries
were not rewritten. Replace this section at the next upstream sync rather than
extending an ever-growing history table.
