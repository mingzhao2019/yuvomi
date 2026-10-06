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

## Previous sync checkpoint (2026-09-30)

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

## Current sync checkpoint (2026-10-01)

Local `main` and `upstream/main` both point to `c471ef0f8` (v2.71.0). The
previous custom checkpoint is `8c7d7206d`; the integration branch started at
that commit and reviewed all eleven upstream commits after `e9426e434` in
order. Ten independent changes were cherry-picked, and the budget-series
change was manually ported because custom migration 238 and its
series-definition semantics differ from upstream. Upstream was not merged
wholesale.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `acd1c2e3b` (#1545, #1585) | Gives a recurring budget series its own start date and freezes missing past occurrences before a grid change. | Manually ported as custom migration 239; retained the custom definition from migration 238, account inheritance, virtual-budget account exclusion, responsibility inheritance, `shared_amount`, permissions and per-entry receipts. |
| `155742f1c` | Makes the calendar import guard assert the rule rather than a source line. | Cherry-picked as `e535adce6`; test-only. |
| `f06c59ca4` (#1592) | Keeps the dashboard plus button in place after leaving wall mode. | Cherry-picked as `ced460c10`; custom dashboard layout remains intact. |
| `cf480557b` (#1590) | Orders tasks and computes the start badge using the household clock. | Cherry-picked as `0311ec134`; preserved the custom task-test exports and added household-timezone coverage. |
| `604acb5c6` (#1595) | Makes the mobile tab-bar capsule thinner and clearer. | Cherry-picked as `958083d52`; existing navigation slots and accessibility fallbacks remain. |
| `818e798a7` (#1529) | Adds Norwegian Bokmål. | Cherry-picked as `70806894b`; kept the custom translation baseline and added the `nb` locale. |
| `a439c23a1` (#1597) | Shows real occurrences immediately after saving a new calendar series. | Cherry-picked as `ec6bad1d4`; retained custom calendar-provider and timezone semantics. |
| `0f05ea01c` (#1594) | Accepts localized installer confirmations and runs the installer on macOS. | Cherry-picked as `f4255dd1d`; no custom deployment contract changed. |
| `ab8a61d35` (#1599) | Derives budget, OpenAPI and weather language lists from locale files. | Cherry-picked as `6fdd03ac5`; retained custom locale behavior and added `test:language-lists` to `npm test`. |
| `05081422d` (#1600) | Clarifies that `OPENWEATHER_LANG` is only a fallback and unknown codes are ignored. | Cherry-picked as `153c2f016`; documentation-only, no provider behavior changed. |
| `c471ef0f8` (#1601) | Shows the selected task beside task history on wide screens. | Cherry-picked as `3369e240b`; combined the detail-component import with `wireScrollFade` and retained custom search, task-list, subtask, and detail behavior. |

The budget port leaves released migration 238 unchanged and appends migration
239. Existing running series backfill `budget_series.start_date` from their
anchor's date; the triggers initialize it for newly created/restarted series.
Single-entry date correction changes only the booked anchor. A series edit
moves the grid only through explicit `start_date`; rhythm or start-day changes
materialize missing occurrences through yesterday on the old definition and
apply the new grid from today. The anchor still moves with the start day only
while it is future-dated. Existing custom account, visibility, responsible
member, virtual amount, permission and receipt behavior remains authoritative.

No release commit is in this upstream range. Root `package.json`, both root
`package-lock.json` version fields, `public/sw.js` `APP_RELEASE`, and current
release metadata remain at `2.71.0`, matching `main:package.json`.

Focused budget validation passed: recurrence (31 assertions), migration
v238/v239, budget UI (124 tests), and budget entry routes (87 tests). The full
`npm test` completed with exit code 0; restore-swap passed 64 tests with 3
root-specific skips, and restore-server passed 15/15. Focused task-history,
master-detail, and detail-view suites passed. `git diff --check` passed.

The earlier dashboard regression remains intact: archived/completed overview
events render `event-item--done` with a line-through, covered by
`test/test-dashboard-today.js`. Microsoft To Do task/list mapping, Outlook and
ICS calendar behavior, persistent task lists, separate personal/household
notification channels, Inventory/assets, and dashboard widgets remain present
with their custom semantics. Validation completed before the local `custom`
fast-forward. No push was performed.

## Current sync checkpoint (2026-10-05)

Local `main` and `upstream/main` both point to `b218afa38` (v2.73.0). The
integration branch `custom-upstream-selective-2026-10-05` started at custom
`202f871b4` and points to `2f2fa2960`; after validation it was fast-forwarded
into `custom`. The upstream range after the previous checkpoint was reviewed
in upstream order. Upstream was not merged wholesale.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `5027becaa` (#1653) | Makes an unknown public descendant such as `/pair/extra` land on `/pair` for signed-out users, while keeping the guest budget detour single-navigation and loop-free. | Cherry-picked as `2ac44cab4`; retained the custom router harness, translated refusal handling, and test-chain entry point. |
| `5b509f0f2` (#1654) | Waits for the overlay-owned asynchronous `back()` before placing a new history marker. | Cherry-picked as `7c4ceb140`; the custom overlay marker, delayed traversal model, and browser guard remain intact. |
| `5044c31ab` (#1655) | A cold direct link to a household-disabled module now reaches the overview after preferences load. | Cherry-picked as `a5f562b02`; composed with the custom same-navigation detour and retained the access/disabled-module guard order. |
| `9ee47ffd4` (#1659) | 403 responses with a known reason use the localized sentence for that reason instead of the server's English text. | Cherry-picked as `0390c73f8`; adopted the shared `REFUSAL_MESSAGES` map for `api.js` and `friendly-error.js`, retained custom reason classification and locale coverage. |
| `ab1ed8fad` | Publishes v2.73.0 release metadata. | Cherry-picked as `5b187d513`; synchronized the root package, both root lockfile versions, service worker, current docs, Umbrel notes, and changelog. |
| `3d95e9330` (#1662) | Periodic medication, prevention-reminder, and recipe-provider jobs rest while their household module is switched off. | Cherry-picked as `559345193`; manually combined the medication notification fan-out with the new health gate, and kept the custom restore gate while applying the recipes-only scheduled gate; manual sync remains available. |
| `7fd981f96` (#1664) | Mixed dashboard/calendar/search/ICS/countdown answers omit data from a household-disabled module; birthdays retain their separate switch semantics. | Cherry-picked as `5ab5a0bc3`; combined `modulesLeftOut()` with custom asset/timezone and event-completion behavior, preserving response shapes and the calendar-versus-birthdays distinction. |
| `e83cd2aaa` (#1666) | Reads timezone offsets at whole-second precision so fractional seconds are converted exactly once. | Cherry-picked as `7bf46a585`; retained custom precise household-time and housekeeping semantics, while moving the fractional-second correction into the shared converters. |
| `1ed1f7a7e` (#1667) | Validates and localizes the paid-installments field in both loan creation dialogs and returns structured refusal reasons. | Cherry-picked as `ca4f0847f`; retained the custom unified loan-field renderer, budget visibility/account semantics, and existing paid-installment bookkeeping. |
| `b218afa38` (#1674) | Mounts unauthenticated pages at the app root instead of nesting their `main` inside the previous page. | Cherry-picked as `2f2fa2960`; retained custom public-route detours and added `test:page-mount` to the custom full-test command. |
| `06bd02c14` | Historical merge of `origin/main` into `fix/task-status-visibility`. | Skipped; merge-only history, with its constituent visibility, reminder, localization, and documentation changes already represented by the previous selective sync/custom tree. |
| `603dd5a8d` | Historical merge of `origin/main` into `ghsa-hc9r-lift`. | Skipped for the same reason; no independent merge behavior should be replayed into custom. |
| `3db82b545` | Historical merge of `fix/task-status-visibility` into `fix/budget-private-views`. | Skipped; its content is the already reviewed branch history plus merge resolution, not a new upstream feature. |

The semantic conflict resolutions in this range were: `package.json` keeps the
custom `test-chain` and appends each new regression suite; medication scheduling
keeps custom `fanOutNotification` while gating health; recipe scheduling gates
only the automatic provider job because manual sync is an explicit user action;
dashboard/countdown imports combine the custom asset and event-completion paths
with the unified disabled-module set; and the housekeeping documentation keeps
the custom split test suites while updating the fractional-second contract. The
upstream rewards migration was relocated from its upstream `230` to custom
`240`, because custom fasting already owns `230`; existing custom migrations
`230` through `239` were left untouched, and the reward tests/docs now refer to
`240`. The custom Microsoft To Do list mapping, Outlook/ICS boundaries,
persistent task lists, separate notification channels, Inventory/assets, and
dashboard widgets remain in place.

The v2.72.0 release cherry-pick also carried three custom-only notes into the
released section. The recurring-budget start-day note and the two receipt
privacy notes were moved back to `[Unreleased]`, where they belong to the
custom release stream. The remaining intentional custom history in the
`[2.72.0]` section is pinned in `test/test-changelog.js` as
`'2.72.0': '06999d64fcbb'`; this exact hash preserves the established section
while still detecting any later unrecorded edit.

Focused validation for this checkpoint passed for rewards, the suite chain,
reminder target visibility, subtask composition, calendar and calendar
deletion, migration append-only behavior, version consistency, and CHANGELOG.
The notification regression fixture was aligned with the existing personal
provider allowlist (`message_pusher`/Webhook); `test:notifications` passes
56/56 without widening ntfy's household-only boundary. The full test result
completed in the authorized environment with `npm test` exit code 0; the
captured log contains no failing subtests. `git diff --check` also passed. No
push or remote state change was performed.

## Current sync checkpoint (2026-10-06)

Local `main` and `upstream/main` both point to `789ff8a98` (v2.73.0). The
integration branch `custom-upstream-selective-2026-10-06` started at custom
`18b6f390c` and points to `8212763d0`; it has not yet been fast-forwarded into
`custom`. The upstream range after the previous checkpoint was reviewed in
upstream order. Upstream was not merged wholesale.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `6bd9110cb` (#1673) | Adds shared spacing, UI building blocks, inputs, and motion primitives across the modules. | Cherry-picked as `0ccbf48a3`; composed the broad UI refresh with custom notification, task-list, calendar, inventory, and dashboard behavior. |
| `d5b193066` (#1677) | Logs provider error fields when OIDC sign-on fails. | Cherry-picked as `7b241ed18`; no custom authentication contract changed. |
| `6d5124a50` (#1678) | Opens a read-only pantry view instead of the editor. | Cherry-picked as `11122f393`; retained custom read/write module gates. |
| `7ba8be04f` (#1681) | Allows revoked and expired API tokens to be removed. | Cherry-picked as `7d4cd17b0`; retained the custom API error and permission contracts. |
| `49b42fccb` (#1684) | Shows 5, 8, or 12 appointments in the overview calendar tile by width. | Cherry-picked as `b3b6c5e65`; retained custom dashboard widgets and event completion state. |
| `b63437459` (#1685) | Bumps `proxy-addr` from 2.0.7 to 2.0.8. | Cherry-picked as `a72ea38d4`. |
| `f610fee81` (#1686) | Sends a refusal with its own reason only once. | Cherry-picked as `6098d1f21`; retained custom refusal classification and localized API behavior. |
| `f99d2b06c` (#1687) | Deactivates a member with shared entries instead of deleting the member. | Cherry-picked as `f74a70589`; appended custom migration 241 after the custom schema and retained the custom deactivation/restore semantics. |
| `80fafe6ee` (#1416) | Deletes split expenses through exact reverse ledger entries. | Adopted as `28333a9da`; retained the reverse-ledger author and rounding behavior required by custom account deactivation. |
| `5280718f6` (#1692) | Moves `navigate()` into its own module. | Cherry-picked as `1493aef5`; retained custom guest-route detours and navigation guards. |
| `bb4231016` (#1691) | Refines the tab strip, calendar week, settings link, and viewer focus behavior. | Cherry-picked as `c51099d57`; combined it with custom settings and document navigation behavior. |
| `ce1fd615c` (#1693) | Shows budget refusal sentences in the app at the relevant field. | Cherry-picked as `20d501990`; retained custom budget visibility and account semantics. |
| `208aedd2c` (#1690) | Gives members with shared initials distinct initials. | Cherry-picked as `25cc4768f`; kept custom member ordering and avatar behavior. |
| `d4586493d` (#1694) | Keeps API budget error sentences in English. | Cherry-picked as `4c73ac5d3`; retained the structured refusal reason contract. |
| `882d620ae` (#1696) | Gives the test infrastructure an OS file path instead of a URL pathname. | Cherry-picked as `c779f9d18`. |
| `7e3dbe36d` (#1710) | Removes roadmap lines that became tracked issues from the Later list. | Cherry-picked as `dad78d91c`; documentation only. |
| `e272bb9ea` (#1717) | Makes demo PDFs real PDFs that the preview can open. | Cherry-picked as `a86bc613a`; retained the custom demo seed paths. |
| `3310c6f99` (#1716) | Uses one reminder-sync name and correct waste color names. | Cherry-picked as `e892c1da6`; retained custom notification-channel labels. |
| `501aa0933` (#1718) | Keeps long board titles, Korean hints, and won amounts visible. | Cherry-picked as `933edd73f`; composed with custom responsive layout rules. |
| `0221339bc` (#1714) | Resuming a recurring split expense skips missed dates. | Cherry-picked as `7df27f7b0`; retained custom reverse-ledger semantics. |
| `acd0e55b1` (#1715) | Adds one shared read row that communicates the action of a tap. | Cherry-picked as `d59d49922`; retained custom read-only module behavior. |
| `4fb50255f` (#1719) | Places overlapping calendar events in lanes by person. | Cherry-picked as `09ca508bf`; retained custom Outlook/ICS boundaries and timezone behavior. |
| `789ff8a98` (#1720) | Lets a household set one order for its members and uses it in member lists. | Manually ported as `8b38f1122`; appended custom migration 242, retained inventory `assigned_users` storage order as an explicit exception, and preserved custom permission/API behavior. |

The integration branch also contains five custom-only follow-up commits: the
custom migration placement for member deactivation, split-expense reversal
suite documentation, the Inventory assignment-order guard, task-list refusal
reason classification coverage, and the notification-help motion-token fix.
They close custom compatibility and test gaps exposed while applying the
upstream commits; they are not additional upstream history.

The main semantic conflicts were resolved as follows. The Microsoft To Do
list mapping, Outlook/ICS rules, persistent task lists, notification channels,
Inventory/assets, and dashboard widgets remain authoritative in custom. The
member deactivation change appends migration 241, and member ordering appends
migration 242; released migrations were not edited. Inventory asset
`assigned_users` keeps its saved order because it is a single-record field,
while people lists use the household order. Split-expense deletion continues
to use the reverse ledger. Upstream UI motion tokens were combined with the
custom notification template help styling.

There is no release-version change in this range: root package metadata,
both root lockfile version fields, `public/sw.js`, and current release
metadata remain at v2.73.0. Microsoft To Do mapping, Outlook/ICS calendars,
persistent task lists, separate personal/household notification channels,
Inventory/assets, and dashboard widgets remain present with their custom
semantics.

Focused tests passed for the API, member ordering, split-expense reversal,
append-only migrations, suite chaining, motion tokens, settings navigation,
and notification-channel forms. The full `npm test` completed with exit code
0. `git diff --check` passed before this documentation checkpoint. No push or
remote state change has been performed yet.
