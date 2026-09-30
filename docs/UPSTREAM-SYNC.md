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
`c274a1565` (v2.70.0). The previous custom checkpoint was `708df9e61`.
Changes were reviewed in upstream order and integrated on
`custom-upstream-selective-2026-09-30`; upstream was not merged wholesale into
`custom`.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `762fcc36f` | Folder-delete preview and result counts follow module rights and record visibility; hidden documents are not disclosed or deleted. | Manually ported as `69bebc020`; kept snapshot comparison ahead of visible-document management checks and preserved hidden-document unfiling semantics. |
| `3f3cee5a9` | Merge of upstream main into the folder-delete feature branch. | Merge carrier only; no additional behavior was separately ported. The folder fix is accounted for above. |
| `c53c77633` | Merge of upstream main into the folder-delete feature branch, with a changelog conflict. | Merge carrier only; no independent behavior beyond the reviewed feature/release changes. Changelog placement was resolved in the integration tree. |
| `6c7f13ae0` | Merge of upstream main into the folder-delete feature branch. | Merge carrier only; no additional behavior was separately ported. |
| `c289e13ba` (#1570) | Web installer adopts the app's visual language, responsive step flow, validation and hand-off to the running app. | Adopted as `2009a811b`; retained the custom app's routes and installer contracts. |
| `09902f832` (#1571) | Installer adds module on/off switches and includes Docker setup in its step list. | Adopted as `163c3b66d`; retained all localized installer behavior. |
| `405450fe5` (#1573) | Website fact corrections, complete installation paths, family section and app design tokens. | Adopted as `dff96232f`; composed the README reward wording to match custom behavior: points go to the member who completes the task, not necessarily its assignee. |
| `6e0760b37` | Merge of upstream main into the folder-delete feature branch. | Merge carrier only; no independent behavior beyond the reviewed feature/release changes. |
| `c274a1565` | v2.70.0 release metadata. | Adopted as `e3e5902c7`; package, lockfile, service-worker and current release metadata agree on `2.70.0`. |

Semantic overlaps were resolved explicitly. The folder-delete fix limits each
module count by both read permission and record visibility, compares the
confirmed snapshot before management checks, and leaves hidden documents in
place while clearing only their folder association. The website's reward
description was corrected in English and German to describe custom completion
recipient semantics. The upstream security explanation for folder deletion was
restored to its released changelog section; the two custom #1358 document
permission entries remain under `[Unreleased]` rather than being moved into the
v2.70.0 release. No released migration or schema history changed.

The earlier dashboard fix `708df9e61` remains in `custom`: completed calendar
events in the overview still render `event-item--done`, its CSS still applies
line-through, and `test/test-dashboard-today.js` asserts that state. No upstream
change in this range superseded that behavior.

The current schema remains migration `237`; no migration files or database
schema code changed in this sync. The root package, both root lockfile version
fields, `public/sw.js`'s `APP_RELEASE`, and current release metadata all match
`main:package.json` at `2.70.0`. Replace this section at the next upstream sync
rather than extending an ever-growing history table.

Focused validation passed for the dashboard completed-event state, folder
deletion, installer, migration append-only guard, landing page, and README
consistency (424 tests total; landing page 109/109, README consistency 17/17).
`git diff --check` passed, and the full `npm test` completed with exit code 0.
The restore-swap suite reported 64 passed, 3 skipped for root-specific
filesystem behavior, and 0 failed.

Microsoft To Do task/list mapping, Outlook and ICS calendar semantics,
persistent task lists, personal and household notification channels,
Inventory/assets, and dashboard widgets were retained; their code and focused
regression coverage were not removed or replaced. No push was performed.
