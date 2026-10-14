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

## Follow-up sync checkpoint (2026-10-06)

After refreshing `upstream/main`, three new upstream commits were selected for
the existing `custom` line. Local `main` and `upstream/main` now point to
`1c8befe40`; the integration branch started at custom `4b72804dc`. This is a
selective integration only: the long-standing custom divergence is not part of
this change and upstream was not merged wholesale.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `4214a2c50` (#1724) | Lets a loan set a monthly due day and dates a paid installment on that day. | Integrated as `b34d8be5d`; relocated the upstream migration to custom migration 243 and retained custom loan, ledger, locale, and test behavior. |
| `999ee2258` (#1726) | Keeps recurring split expenses anchored to the 29th, 30th, or 31st where the target month permits it. | Integrated as `08284cdea`; relocated the upstream migration to custom migration 244 and retained custom reverse-ledger and scheduler behavior. |
| `1c8befe40` (#1730) | Fits every chart gutter to the widest rendered axis value, including charts mounted later or initially hidden. | Integrated as `7531e498a`; retained custom chart and layout behavior. |

Custom migrations 233, 234, 241, and 242 were left unchanged. The effective
change from custom for this follow-up is 55 files, 2,581 insertions, and 150
deletions; it does not represent the historical custom/upstream divergence.

Focused loan validation passed 19/19, recurring split validation passed 40/40,
and the chart-gutter logic test passed. The browser chart suite could not run
because the required Puppeteer Chrome 152.0.7977.42 is not installed in this
environment. No push or remote state change has been performed yet.

## Current sync checkpoint (2026-10-07)

Local `main` and `upstream/main` both point to `45a55a954` (v2.73.0). The
integration branch `custom-upstream-selective-2026-10-06` started at custom
`97a4447c0` and was fast-forwarded into `custom` at `a15c0b8b8` after
validation. The eight upstream commits after the previous checkpoint at
`1c8befe40` were reviewed and integrated in upstream order. Upstream was not
merged wholesale.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `95cb03e9f` (#1725) | Localizes holiday country names and regions, adds a standalone bulk-delete label, and keeps the CalDAV section name. | Cherry-picked as `5e63247ab`; retained custom locale and calendar contracts. |
| `7b67c1880` (#1732) | Updates `sharp` from 0.35.4 to 0.35.5, including the bundled security fix. | Cherry-picked as `71b6aad44`. |
| `2d3bc0e40` (#1731) | Removes meal-plan and recipe write controls for members with read-only kitchen access. | Cherry-picked as `9a11f47e9`; retained the custom module gates and pantry write boundary. |
| `b23f974dc` (#1729) | Clarifies housekeeping, waste, dashboard-size, and weather-settings wording. | Cherry-picked as `315e4b3a2`; existing custom stored values remain unchanged. |
| `834646603` (#1665) | Lets each device choose its screensaver idle delay. | Cherry-picked as `78775fcdc`; kept the device-local storage contract and theme-init path. |
| `060304f77` (#1735) | Removes inventory/document write controls on read access and enforces document ownership in the UI. | Cherry-picked as `ab9261e46`; retained server-side permission and visibility rules. |
| `47964c697` (#1736) | Adds coverage for the inventory/document read-only gates and their write-access counter-cases. | Cherry-picked as `253057973`. |
| `45a55a954` (#1737) | Lets a meal and a recurring meal series name a household member as cook. | Manually ported as `54d1857e0`; relocated the upstream migration 235 to custom migration 245 and retained custom member, deactivation, permission, API, and UI behavior. |

The upstream meal feature was the only semantic port in this range. The
custom schema already owns migrations 233 and 234, and the custom branch had
since added migration 241 and 242, so the nullable cook columns were appended
as migration 245 without changing released migrations. The cook is a shared
responsibility rather than ownership: `meals: read` still controls visibility,
`meals: write` controls edits, only household members can be newly selected,
and a stored cook remains valid while the account is deactivated. Single-meal,
series, and apply-plan writes preserve the missing-field semantics documented
in `docs/SPEC.md`.

The locale patch required one custom follow-up, `1c3dedfb3`, removing five
duplicate plural keys that the upstream localization change encountered in
custom `ar`, `pl`, `ru`, and `uk` files. This was a correction to the merged
locale state, not another upstream commit. It restores `test:i18n` without
discarding any newly translated key.

There is no release-version change in this range: root package metadata, both
root lockfile version fields, `public/sw.js`, and current release metadata
remain at v2.73.0. The CI workflow now sets `PUPPETEER_SKIP_DOWNLOAD` and
points Puppeteer at the hosted runner's `/usr/bin/google-chrome`; the previous
failure happened during `npm ci` while Puppeteer was downloading Chrome, so
the test command had not started.

Focused validation passed for meals/cook (40/40), dashboard, frontend audit,
schema and migration append-only checks, i18n, and plural i18n. The second
full `npm test` run completed with exit code 0 and no failing subtests.
`git diff --check` passed. After validation, both `main` and `custom` were
pushed to `origin` by fast-forward; no force-push was used.

## Current sync checkpoint (2026-10-07, follow-up)

After refreshing `upstream/main`, ten new upstream commits were reviewed in
order and selected for the custom line. Local `main` and `upstream/main`
both point to `b0f4a02c3` (the v2.74.0 release plus the follow-up UI fixes).
The integration branch `custom-upstream-selective-2026-10-07` started at
custom `8cae9bd61`. This is a selective integration only: upstream was not
merged or rebased wholesale.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `fd62a75d5` (#1738) | Adds Singapore dollar (SGD) and an `en-SG` region preset. | Cherry-picked as `499389343`; retained custom region and currency behavior. |
| `e47c5b7fb` (#1740) | Clarifies that the training log is a third-party module. | Cherry-picked as `6caf64766`; documentation only. |
| `f09e69820` (#1743) | Dates an overdue loan installment in its own month. | Cherry-picked as `c730dfe67`; retained custom loan and ledger behavior. |
| `11f7e3244` (#1739) | Adds meal-cook follow-ups, strict cook identity, and no picture per meal. | Cherry-picked as `cce71a818`; retained custom migration 245 and member/deactivation semantics. |
| `d93392194` (#1742) | Publishes the v2.74.0 release metadata. | Cherry-picked as `d73d680f7`; synchronized release metadata with local `main`. |
| `6de9b8cd3` (#1744) | Adds listing, editing, pausing, resuming, and deletion for recurring split expenses. | Cherry-picked as `6bf64b0f2`; retained custom reverse-ledger and migration 244 behavior. |
| `3289c8746` (#1745) | Adds pocket money balances and money requests per child. | Integrated as `ee0c52ffd`; relocated upstream migration 236 to custom append-only migration 246. |
| `1caf10921` (#1769) | Updates roadmap and scope documentation. | Cherry-picked as `dc12f8763`; documentation only. |
| `cfbe458f3` (#1767) | Applies the 2026-10-07 UI critique across layout, dialogs, filters, motion, and tests. | Cherry-picked as `15f313129`; combined custom task, calendar, inventory, settings, locale, and compatibility behavior. |
| `b0f4a02c3` (#1779) | Fixes seven review leftovers from the UI critique. | Cherry-picked as `ae42e15c9`; adopted the coupled modal, filter, budget, schedule, waste, locale, and regression-test fixes. |

The upstream commit count for this checkpoint is exactly ten. One custom-only
follow-up commit accompanies the integration: it restores the published
`2.74.0` changelog text, wires the recurring-expense UI suite into `npm test`,
removes the duplicate migration `234` test-suite note, restores locale-key
parity after conflict resolution, and keeps the Outlook selection save status
accessible without changing the save button label. Custom migration 244
remains the recurring split-expense migration, migration 246 remains
append-only, and the old migration 234 is not reintroduced or rewritten. The
custom Puppeteer CI fix remains in custom and was not copied into the pure
upstream `main` line.

The semantic overlap decisions are: meal-cook columns remain under custom
migration 245; pocket money is append-only at migration 246; recurring split
expenses retain the custom reverse ledger; the settings UI keeps the lunar
calendar switch and all-day reminder time; inventory keeps the administrator
category manager and custom asset behavior; and task-list, Microsoft To Do,
Outlook/ICS, notification-channel, Inventory/assets, and dashboard contracts
remain authoritative in custom.

Final validation passed as follows:

- `npm run test:changelog`: 34/34 passed.
- `npm test`: exit code 0 with no failing subtests. The restore-rekey suite
  reported 15 passed and 1 root-only filesystem case skipped.
- `git diff --check`: passed.
- Root `package.json`, both root `package-lock.json` version fields,
  `public/sw.js`'s `APP_RELEASE`, and current release metadata agree on
  `2.74.0`.

The custom-only cleanup is committed after the ten selected upstream commits.
The temporary integration branch is then fast-forwarded into `custom`, the
temporary branch is deleted, and `origin/main` and `origin/custom` are pushed
with ordinary fast-forward updates. No force-push or wholesale upstream merge
is allowed.

## Current sync checkpoint (2026-10-08)

After refreshing `upstream/main`, four upstream commits were reviewed in
upstream order and integrated on `custom-upstream-selective-2026-10-08`. Local
`main` and `upstream/main` are at `66575de23`; the integration branch started
at custom `6bbf29aaf` and currently ends at `9a9746aee`. This is a selective
integration only: upstream was not merged wholesale into custom.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `f7ca9b63a` | Publishes the v2.75.0 release metadata and release notes. | Cherry-picked as `447b56075`; custom-only release-note changes were reconciled in `5197e903b` so the released section remains upstream-compatible and custom notes stay under `[Unreleased]`. |
| `b500010ce` (#1794) | Delivers the R18 craft pass: startup/update handling, network-first and static-asset caching, material surfaces, motion, row actions, detail heads, form rows, and their regression suites. | Integrated as `123b3da60` with semantic conflict resolution. The upstream UI behavior and tests were adopted where compatible; custom task-list, Markdown checklist, timezone/lunar, sidebar sizing, service-worker `no-cache`, permission, API, and test-topology contracts were retained. |
| `809253056` | Adds the row-title typography role to the `DESIGN.md` frontmatter. | Cherry-picked as `b25cec090`; documentation only. |
| `66575de23` | Aligns the kitchen row rule and brand-mark frontmatter with R18's More action and SVG brand mark. | Cherry-picked as `9a9746aee`; documentation only. |

The R18 conflicts were resolved by behavior rather than by selecting whole
files. Custom task sources and persistent lists remain first-class, Markdown
checklists remain separate from Microsoft To Do steps, and custom timezone and
lunar-calendar behavior remains in place. The R18 detail view moves the due
date into `taskDetailHead`, so the custom test now checks the head instead of
requiring the old render function to contain that label. The custom sidebar
slots and widths remain, while compatible R18 row, material, motion, startup,
network-timeout, static-cache, and detail-view changes are included. Locale
files keep custom translations, receive all upstream keys, and were checked
for duplicate keys; the two missing Norwegian and Brazilian Portuguese empty
state titles were restored explicitly. The custom service worker's no-cache
behavior was preserved alongside the upstream network-first/static-asset
coverage.

There is no migration or data-model change in this range. Root `package.json`,
both root `package-lock.json` version fields, `public/sw.js`'s `APP_RELEASE`,
and current release metadata agree on `2.75.0`. Microsoft To Do mapping,
Outlook/ICS calendars, persistent task lists, separate personal/household
notification channels, Inventory/assets, and dashboard widgets remain present
with their custom semantics.

Focused validation passed for i18n, locale switching, task detail rendering,
material UI, service-worker behavior, calendar behavior, static assets, and
motion. The first full `npm test` run reached the motion suite and exposed an
integration-only baseline mismatch: upstream's hover ratchet was 240, while
custom had 271 unguarded rules before R18 and 256 after the R18 cleanup. The
ratchet was therefore set to the custom baseline of 256, retaining the
non-increasing guard. The affected `test:motion` suite passes 64/64, and
`test:frontend-audit` passes 475/475 when its required Node child processes
are allowed; the sandbox-only run reports `spawnSync ... node EPERM`. The full
`npm test` chain was not rerun after these focused corrections, so that final
end-to-end status remains unverified. `git diff --check` passes. After the
integration commit, local `main` will be fast-forwarded to the refreshed
`upstream/main`, then the temporary integration branch will be fast-forwarded
into `custom`; no force push or wholesale upstream merge is used.

## Follow-up sync checkpoint (2026-10-08)

After the previous checkpoint, `upstream/main` advanced from `66575de23` to
`eb8d6c828`. The ten commits through `775b558f6` and the new screensaver test
commit were reviewed in upstream order. Local `main` and `upstream/main` now
both point to `eb8d6c828`. The integration branch
`custom-upstream-selective-2026-10-08` started at custom `29f995527` and
currently points to `cf7ec71c0`. Upstream was not merged wholesale.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `729d98f36` (#1815) | Gives the CI test job thirty minutes. | Adopted as `1e6e5bf1d`; retained the custom Puppeteer download/host Chrome setup that prevents `npm ci` from failing during browser download. |
| `3db5372e3` (#1809) | A display no longer offers Customize and Search from the dashboard. | Adopted as `076c17404`; preserved the custom dashboard asset/widget and navigation contracts. |
| `2e74892b6` (#1813) | Fixes stale state in the meal dialog and budget month view. | Adopted as `903f07530`; retained custom calendar, timezone, and budget behavior. |
| `d4ca8c6ae` (#1810) | Refreshes an ICS feed when an imported event changes UID. | Adopted as `584f6880a`; preserved the custom ICS read-only boundary and event identity rules. |
| `dc2cdc921` (#1811) | Sends the redirect URI as an authorized OIDC token-request field. | Adopted as `2482ae903`; retained the custom OIDC error and identity handling. |
| `449d1676c` (#1812) | Fixes mmHg wrapping, schedule ranges, field-picker names, and test harness behavior. | Adopted as `84fd1dc35`; retained custom schedule, locale, and test-chain contracts. |
| `a52c3e1c5` (#1819) | Refuses startup on Node.js versions without Node-API 10. | Adopted as `86dbdc98e`; retained the custom runtime guard and supported-version diagnostics. |
| `79b975de2` (#1820) | Makes a shopping dashboard tile open its own list. | Adopted as `f416f3977`; preserved the custom dashboard module and task-list entry points. |
| `146f3728e` (#1727) | Adds a per-subscription payment reminder switch. | Adopted as `811887ebc`; retained custom reminder, notification, permission, and timezone semantics. |
| `775b558f6` (#1822) | Makes locked fields visibly locked across the UI. | Adopted as `41ee69e54`; retained custom destructive-control exceptions in the audit and preserved the existing read/write gates. |
| `eb8d6c828` (#1786) | Covers the untouched-device screensaver default, stored select value, and timer-delay interaction. | Cherry-picked as `cf7ec71c0`; exported `screensaverIdleOptions()` for the test and retained the device-local screensaver contract. |

Two custom-only follow-up commits accompany this range: `49cda5aba` keeps
custom test-chain entry points after the upstream script changes, and
`c3c56d4c6` records the custom destructive-control exceptions in the frontend
audit. They are compatibility corrections, not additional upstream commits.

There is no migration or data-model change in this range. Version metadata
remains `2.75.0` across the root package, both root lockfile fields,
`public/sw.js`, and current release metadata. The screensaver change adds no
runtime storage model or API surface. Microsoft To Do list mapping, Outlook
and ICS calendars, persistent task lists, separate personal/household
notification channels, Inventory/assets, and dashboard widgets remain present
with their custom semantics.

The full `npm test` chain completed on the integration tree before the final
screensaver-only upstream commit; its log contains no failing subtests. After
`eb8d6c828`, `npm run test:screensaver-idle` passed and `git diff --check`
passed. The post-commit full chain was not rerun because the final upstream
change only adds regression coverage and a named test export; that residual
scope is explicitly recorded here. No force-push or wholesale upstream merge
was used.

## Current sync checkpoint (2026-10-10)

`git fetch upstream` advanced `upstream/main` from `eb8d6c828` to
`348228c24`. Local `main` was fast-forwarded to that exact upstream commit.
The selective integration started from custom `5b21d569d` on the temporary
branch `custom-upstream-selective-2026-10-10`; it did not merge the upstream
branch wholesale and it did not push anything.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `422f0e56e` (#1823) | Sort budget loans by interest rate or remaining balance. | Adopted as `942cdfe8a`; retained custom due-day, household-timezone, payment-date, currency, and test-chain behavior. |
| `3c5af1ba5` (#1835) | Close loopback connections in the reminder visibility test. | Adopted as `50ce55397`; test-harness-only change. |
| `743871a74` (#1827) | A wall display reading `events_scope=mine` sees all events. | Adopted as `99c1180dc`; the display-only rule stays at the dashboard reader, while member and API-token semantics remain personal. |
| `37d013563` (#1832) | Dashboard overview rows open their item and preserve focus while rebuilding. | Adopted as `d35c274bd`; retained custom dashboard exports, asset widget, and navigation contracts. |
| `348228c24` (#1831) | Choose which shopping lists the shopping tile shows. | Adopted as `7b440d1d6`; the selection populates `shoppingTile` only, while Today, wall, navigation, and asset data keep their existing unfiltered/custom payloads. |

The conflict resolutions preserved the custom Inventory/assets widget and
payload, the shopping row entry points, display permissions and area modules,
budget due-day and timezone behavior, and the custom documentation wording.
The package test chain includes the new loan-order and dashboard-shopping
regressions. A duplicate widget-map entry left by the dashboard conflict was
removed in the custom follow-up, and the new loan-sort hover rule was placed
under `@media (hover: hover)` so it preserves the touch-device hover ratchet.

There is no migration or data-model change in this range. Version metadata
remains `2.75.0` across the root package, both root lockfile fields,
`public/sw.js`, and current release metadata. Microsoft To Do list mapping,
Outlook and ICS calendars, persistent task lists, separate personal/household
notification channels, Inventory/assets, and dashboard widgets remain present
with their custom semantics.

Focused validation passed: dashboard shopping selection 30/30, dashboard
clarity 56/56, loan routes 66/66, loan amortization 26/26, reminder visibility
34/34, display account 50/50, display task entry points 6/6, and motion 64/64.
The complete `npm test` chain passed after the touch-hover compatibility fix
(exit code 0), and `git diff --check` passed. No force-push or wholesale
upstream merge was used.

## Current sync checkpoint (2026-10-11)

`git fetch upstream` advanced `upstream/main` from `348228c24` to
`70f13e6f5`. Local `main` was fast-forwarded to that exact upstream commit.
The selective integration started from custom `de6d102d4` on the temporary
branch `custom-upstream-selective-2026-10-11`; all sixteen upstream commits
were reviewed and cherry-picked in upstream order. The upstream branch was
not merged wholesale.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `a85bbf9ef` (#1834) | A wall tablet no longer reuses a stored “Assigned to me” filter. | Adopted as `6a93653c7`; retained custom display and dashboard filtering semantics. |
| `c4fac1b3a` (#1826) | Wall mode shows the calendar name and time range. | Adopted as `cf2c8af8b`; preserved custom wall layout and test-suite documentation. |
| `4b38e2636` (#1845) | Shortcut handling tolerates a key event without a key. | Adopted as `13dc34955`; no custom shortcut behavior was removed. |
| `aee756bc7` (#1854) | Pocket money without an account explains its purpose. | Adopted as `e713a6cb4`; retained custom rewards wording and account rules. |
| `3d438e9b3` (#1852) | The demo household includes pocket money. | Adopted as `d9fbde398`; no migration or schema change was needed. |
| `b409a0777` (#1858) | Wall mode counts every assignee and shows the event icon. | Adopted as `52b04e3cd`; preserved custom event colors and wall payload semantics. |
| `72691ed6b` (#1851) | Notes grid stops at four columns. | Adopted as `37430e5bc`; retained custom notes reader behavior. |
| `de6082e68` (#1850) | Waste first-run state is centered on desktop. | Adopted as `2ad1bdf6e`; visual-only change. |
| `2f42b9f59` (#1837) | A CalDAV server refusal is reported as a failed sync. | Adopted as `2a023e99d`; preserved custom task-list binding and outbound retry semantics. |
| `3b96bf605` (#1864) | Budget category-manager labels use the correct language. | Adopted as `4b3e6cf54`; retained custom localized error and label mappings. |
| `4204f7abb` (#1853) | Long account names wrap in the budget view. | Adopted as `c728e52b9`; no data-model change. |
| `760c6e5a4` (#1865) | Safari keeps the hyphenation limit on long words. | Adopted as `95d4f57d8`; added the missing WebKit declarations in the affected custom rules. |
| `5507c4c1e` (#1829/#1867) | Today sheet shows the event icon. | Adopted as `6f1dc89c8`; removed a duplicate service-worker precache entry left by the conflict resolution. |
| `87392e492` (#1869) | Subscription renewal follows edit permission. | Adopted as `f3811c3d9`; preserved custom permission and reminder behavior. |
| `0210615cd` (#1844/#1866) | Subscription appears in every month in which it is due. | Adopted as `856f61d8b`; retained custom budget projection semantics. |
| `70f13e6f5` (#1787/#1868) | Overview can grant a rewards bonus. | Adopted as `0b5c1795c`; preserved custom rewards and overview contracts. |

The conflict resolutions preserved the custom dashboard/widget payloads,
event-color behavior, CalDAV task-list binding, budget and subscription
semantics, and the existing test-chain wrapper. The CalDAV integration also
shares one refusal gate across local creates and pending updates so one
collection refusal consumes exactly one attempt. Automatic reminder outbound
updates now require provenance for Yuvomi-shaped UIDs, preventing legacy or
foreign mirrored objects from being dirtied solely by default reminders. Two
upstream test additions were adapted to the custom migration-test helper names.

There is no migration or schema change in this range. Version metadata remains
`2.75.0`. Focused validation passed: CalDAV HTTP refusals 51/51, CalDAV own
UID 50/50, reminder policy, CalDAV outbound, inherited-color migration 12/12,
service-worker precache, and typography 22/22. The complete `npm test` chain
passed after the integration fixes (exit code 0), and `git diff --check`
passed. No force-push or wholesale upstream merge was used.

After validation finished, `upstream/main` advanced again with
`293e0022c` (#1875/#1877) and `facffb187` (release `v2.76.0`). Those two
commits arrived after the sixteen-commit selection and were intentionally not
added to `custom`; local and remote `main` were separately fast-forwarded to
`facffb187` so the main branch remains an exact mirror of the current upstream.

## Current sync checkpoint (2026-10-14)

`git fetch upstream` was rerun before this sync and found no movement:
local `main` and `upstream/main` both point to `6210698455` (v2.76.0).
The selective integration started from custom `6a71b42ac` on
`custom-upstream-selective-2026-10-14`. All 51 commits after the previous
checkpoint at `70f13e6f5` were reviewed and incorporated in upstream order;
the upstream branch was not merged wholesale.

| Upstream commit | Behavior | Integration decision |
| --- | --- | --- |
| `293e0022c` (#1875/#1877) | Google outbound events use the configured household time zone. | Adopted; retained custom precise time conversion and provider semantics. |
| `facffb187` | Publishes v2.76.0 release metadata. | Adopted; synchronized current package, lockfile, service-worker, release, and installer metadata. |
| `beb0d6134` (#1860/#1879) | CalDAV imports attribute mirrored events and pending deletions to the account that brought them. | Manually composed; preserved custom account/list identity and relocated the upstream migration to custom migration 248. |
| `e1ff416b7` (#1861/#1862/#1880) | A refused move or edit during upload no longer loses or rolls back local changes. | Adopted with the custom CalDAV outbound/refusal state machine. |
| `efcf6117` (#1886) | A waiting removal deletes only its own remote entry. | Adopted; retained custom UID, account, and target checks. |
| `46bd79e8b` (#1855) | Archived expense groups reject writes on the server. | Adopted; retained custom API refusal reasons and permissions. |
| `74b2ebcc7` (#1849) | Adds DD-MM-YYYY and selects it for the Netherlands. | Adopted; retained custom locale and date-format settings. |
| `a8d121444` (#1894) | Pins the money-account test clock and time zone. | Adopted; test-only. |
| `56336dae6` (#1824) | Checked-off shopping items move into a collapsed section. | Adopted; retained custom list selection and dashboard entry points. |
| `23f47dee1` (#1728) | Category bars filter the budget transaction list. | Adopted; retained custom budget visibility and account semantics. |
| `939a662d8` (#1752) | Updates Norwegian Bokmål wording. | Adopted; merged with the custom locale baseline. |
| `2a117de04` (#1893) | An upload follows a target changed while it was in flight. | Adopted with custom CalDAV target/list guards. |
| `ec2599715` (#1791) | A profile picture can be fetched from Gravatar once. | Adopted; retained the custom profile and privacy contract. |
| `d89d6abbe` (#1896) | Corrects the dashboard “due soon” wording. | Adopted; localization only. |
| `4dd395fb2` (#1825) | Wall mode names today’s tasks under each person. | Adopted; combined with custom wall payload and visibility rules. |
| `bfb7767c6` (#1838) | Wall mode shows only household-visible entries. | Adopted; retained display-specific permissions and scopes. |
| `6b3698f54` (#1898) | Gravatar hints and errors name the configured service. | Adopted; retained custom provider allowlists. |
| `444a192a9` (#1899) | Budget focus stays on the tapped category bar. | Adopted; UI-only. |
| `52932e171` (#1792) | Adds a per-device screensaver clock and full-bleed photos. | Adopted; retained device-local settings and custom display gates. |
| `ac8b6232e` (#1895) | Deleting after a lost upload response remains deleted. | Adopted with custom CalDAV upload notes and retry behavior. |
| `fe88d4619` (#1646) | Adds manual task order within a category. | Adopted; relocated the upstream migration to custom migration 252 and preserved persistent task-list ordering. |
| `9b33af691` (#1900) | Wall mode omits personal entries like a paired display. | Adopted; retained the custom wall response shape. |
| `a93e6e430` (#1902) | A deletion for a switched-off calendar waits. | Adopted; retained custom calendar selection and retry semantics. |
| `5ea40b7dd` (#1907) | Wall responses carry only fields drawn by the wall. | Adopted; preserved custom asset and event-color payloads. |
| `d82d9e0f4` (#1671) | Allows opt-in module installation from GitHub or a ZIP in Settings. | Adopted; retained custom install guards, path validation, and opt-in behavior. |
| `1fc352502` (#1700) | Moves a shopping item to another list, including its CalDAV entry. | Manually composed; relocated the upstream migration to custom migration 253 and retained custom list identity and move/refusal handling. |
| `66299fe3f` (#1892) | Corrects Dutch notes and due-label wording. | Adopted; localization only. |
| `50d42b20c` (#1913) | Uses one checked path for a module ID from a request. | Adopted; retained custom API and permission gates. |
| `aac939908` (#1914) | A skipped upload leftover no longer shields a deleted row. | Adopted with custom CalDAV leftover/UID handling. |
| `d74b4401d` (#1793) | A paired wall tablet can show the photo screensaver. | Adopted; retained display scopes and administrator switch semantics. |
| `2157ab5f4` (#1915) | Wall-mode text says the display is fixed, not its arrangement. | Adopted; localization only. |
| `9b2efe8c5` (#1916) | Shopping error toasts use the app’s sentence. | Adopted; retained structured refusal reasons. |
| `21bbcf3b6` (#1920) | `friendlyError` names the server’s cause again. | Adopted; retained custom localized error mapping. |
| `0f95e859d` (#1921) | Shopping reloads itself when an item has disappeared. | Adopted; preserved custom list and selection state. |
| `fe6afeb6e` (#1924) | Deleting an already-gone shopping item succeeds. | Adopted; retained idempotent API behavior. |
| `f5c54465b` (#1243) | Adds multiple first-class local calendars. | Manually composed; relocated the upstream migration to custom migration 255, retained local-calendar color/completion and CalDAV/ICS target precedence, and preserved custom calendar UI. |
| `0a44034a7` (#1925) | Deleting a gone list, store, or category succeeds. | Adopted; retained custom deletion permissions and response contracts. |
| `ea4581bb8` (#1928) | An event moved away during upload is not booked as uploaded. | Adopted with custom calendar outbound target checks. |
| `8c0024712` (#1930) | A series receiving an exception in flight stays local. | Adopted; regression coverage composed with custom recurrence behavior. |
| `3c209cf3a` (#1931) | Waste error toasts use the app’s sentence. | Adopted; retained custom error-key mapping. |
| `b7b323b62` (#1933) | A Google edit made during upload is sent afterwards. | Adopted; retained custom Google conflict and timezone behavior. |
| `6cc5a2e4` (#1936) | Waste import and URL-source errors use the app’s sentence. | Adopted; retained custom source-state and localization contracts. |
| `9e09f5199` (#1939) | A feed without calendar entries keeps the last waste pickups. | Adopted; retained custom empty-feed safety behavior. |
| `98d3b124d` (#1943) | Store management names the store, not the category. | Adopted; UI/error wording only. |
| `6aa6207e0` (#1944) | The screensaver idle timer stays off until somebody is signed in. | Adopted; retained device-local timer behavior. |
| `56e536030` (#1923) | The wall footer button starts the photo screensaver. | Adopted; retained custom wall layout and display permission gates. |
| `1b943f2c1` (#1946) | A manually started screensaver survives the pointer leaving the button. | Adopted; UI behavior only. |
| `99a8de6b5` (#1948) | Pins module-install guards so tests cannot bypass them. | Adopted; retained the custom install safety boundary. |
| `775bb4025` (#1949) | Changelog tests catch conflict markers and duplicated rubric entries. | Adopted; test-only. |
| `810f9952e` (#1952) | A switched-off medication has no due dose on the page. | Adopted; retained custom health permissions and scheduler behavior. |
| `621069845` (#1954) | An entry note clears the wall clock and the footer gains a scroll edge. | Adopted; retained custom wall layout and dashboard payload contracts. |

The migration conflict was resolved append-only. Custom migrations 238–247
remain unchanged. The eight imported schema changes that originally used
upstream versions 238–245 now run as custom migrations 248–255:
CalDAV account attribution, search-trigger narrowing, deletion ETags, upload
attempt notes, task order, shopping moves, display screensaver state, and
local calendars. The schema mirror and the migration append-only test both
cover the resulting sequence; no released migration was rewritten.

The main semantic overlap decisions were to combine all CalDAV/Google
in-flight and lost-response fixes with the custom task-list identity, own-UID,
refusal, target, and timezone rules; combine wall/display changes with the
custom asset, event-color, visibility, and paired-device contracts; and add
local calendars without removing completion controls, local colors, or the
ICS/CalDAV target boundary. The existing custom test-chain wrapper and its
additional suites were preserved. No redundant custom feature was removed
wholesale.

Version metadata is synchronized at `2.76.0` in the root package, both root
lockfile fields, `public/sw.js`, and current release metadata. Focused
validation and the full `npm test` chain passed on 2026-10-14, including the
final hover, localized-error, locale-canonicalization, and changelog checks.
The temporary integration branch is ready to fast-forward into `custom`.

## Current sync checkpoint (2026-10-14, v2.77.0)

The upstream remote was refreshed from `6210698455ea` to
`369958246ea650bccb8f2379fca3f83ec9a48308` (`v2.77.0`). Local `main` was
fast-forwarded to that upstream tip. The selective integration started from
the actual custom tip `0bb28c5da08c5b1d8128f141910e93ef153ed6f7` on the
temporary branch `custom-upstream-selective-2026-10-14`; upstream was not
merged wholesale.

All nine new upstream commits were reviewed and integrated in upstream order:

| Upstream commit | Behavior | Integration result |
| --- | --- | --- |
| `9abae6dff` | Publishes v2.77.0 release metadata. | Adopted as `4527a727a`; synchronized package, lockfile, service-worker, release, and installer metadata. |
| `29d8d5c58` | Bumps the Node action. | Adopted as `2e21a0678`. |
| `79e7b7f18` | Bumps setup-node. | Adopted as `335382297`. |
| `2a795e5d3` | Bumps the Claude action. | Adopted as `af9fe0bc3`. |
| `219062006` | Keeps an authored series start aligned on every push. | Manually composed as `69af3ca26`; retained custom reminder, color, recurrence, and completion semantics, with the schema change relocated to custom migration 256. |
| `800f5ec8b` | Updates development dependencies. | Adopted as `c82276a6c`. |
| `21d94e1d0` | Leaves event time untouched for title-only calendar saves. | Manually composed as `aeac4d552`; retained the custom UI and test-chain wrapper. |
| `7d26dc4df` | Updates production dependencies, including `tsdav` 2.4.0. | Manually composed as `12f90076d`; retained custom CalDAV task-list, UID, target, and refusal behavior and adapted empty/missing multiget handling. |
| `369958246e` | Checks account origin for CalDAV reminder/task synchronization. | Adopted as `2043db072`; added the focused Todo-origin regression test. |

The semantic conflict points were the custom migration numbering, the active
custom test wrapper, authored-series and reminder timezone behavior, and
CalDAV 2.4 response/refusal handling. No existing custom feature was removed.
The follow-up CalDAV compatibility fix is committed as
`827297d26` (`fix(caldav): tolerate empty tsdav multiget responses`).

Version metadata is synchronized at `2.77.0` in the root package, both root
lockfile fields, `public/sw.js`, and release metadata. Focused validation has
passed for authored-series origin (66/66), calendar form timezone (13/13),
CalDAV Todo origin (7/7), CalDAV HTTP refusals (68/68), CalDAV own UID
(204/204), CalDAV/CardDAV, shopping moves, Google/Outlook calendar flows,
MCP, and dashboard suites. `git diff --check` is clean. The final full
`npm test` remains the last validation step before fast-forwarding `custom`
and pushing both `main` and `custom` without force.

## Current sync checkpoint (2026-10-14, v2.77.1)

The upstream remote was refreshed from `369958246ea6` to
`0109e2f355b8848963b9fc4dbfc6453e89d2d13a` (`v2.77.1`). Local `main` was
already fast-forwarded to that exact upstream tip. A later refresh found no
new `upstream/main` commit; two unrelated upstream topic branches were left
out. The selective integration continued on
`custom-upstream-selective-2026-10-14` from custom `0bb28c5da08c5b1d8128f141910e93ef153ed6f7`;
the upstream branch was not merged wholesale.

All sixteen commits after `v2.77.0` were reviewed and integrated in upstream
order:

| Upstream commit | Behavior | Integration result |
| --- | --- | --- |
| `8279b0bd7` (#1972) | Waste source errors use the app's sentence. | Adopted as `978a13e90`; retained custom source-state and localization contracts. The appended schema change was relocated to custom migration 257 because custom v247 is already a released subscription migration. |
| `4989d5bb5` (#1975) | A dated Google series ends on the same local-day occurrence. | Adopted as `950c91d8f`; retained custom calendar-zone and recurrence semantics. |
| `a3dc4a419` (#1956) | An inbound calendar echo preserves the entered aligned series start and related state. | Manually composed as `9452d488b`; retained custom provider, reminder, and read-only boundaries. The appended snapshot column was relocated to custom migration 258 because custom v248 is already the CalDAV account migration. |
| `41e33f5be` (#1971) | Health error toasts use the app's sentence. | Adopted as `dea66a9f4`; retained custom health permissions and localization. |
| `84c4d1274` | Publishes v2.77.1 release metadata. | Adopted as `eaa32f929`; synchronized current package, lockfile, service-worker, release, and installer metadata. |
| `2291c4c4a` (#1987) | A lifted modal footer finds its form by id. | Adopted as `0521f2961`; retained custom modal and save behavior. |
| `c08b1a6dc` (#1988) | Only administrators are offered housekeeping profile writes. | Adopted as `1b3e5fe93`; retained custom permission gates. |
| `e5473cf0c` (#1978) | Wall tests wait for the real requests before asserting. | Adopted as `8e6b4519d`; retained the custom wall asynchronous behavior. |
| `ba7341555` (#1979) | Repository paths are compared in POSIX form on Windows. | Adopted as `3328cd928`; test-infrastructure only. |
| `100909c65` (#1980) | Verdict scripts use their path and close the migration database. | Adopted as `b76fa76f6`; test-infrastructure only. |
| `0b0ccd6e3` (#1981) | Rekey tests place TMP/TEMP beside TMPDIR. | Adopted as `e6a8170c0`; test-infrastructure only. |
| `d311e30ea` (#1982) | Windows skips chmod-only permission cases. | Adopted as `f60ca81f5`; test-infrastructure only. |
| `3ea49f388` (#1983) | Installer env helper input is passed through stdin. | Adopted as `38ae6fdb9`; retained installer quoting behavior. |
| `64aebddf6` (#1984) | Instance-lock waiting tests use a shorter attempt. | Adopted as `b27239e57`; test-infrastructure only. |
| `48fd2bc13` (#1968) | Budget category and subcategory rows show their share of the total. | Adopted as `ce2eefcdd`; retained custom budget account, visibility, and timezone semantics. |
| `0109e2f35` (#1989) | A repeat-option series end lands on the same occurrence in every calendar. | Adopted as `fa29d39fb`; retained custom RRULE read-only and provider-target boundaries. |

The migration conflict was resolved append-only: existing custom migrations
247 and 248 remain unchanged, while the two newly imported upstream migrations
run as custom 257 and 258. The migration test, schema mirror, and CalDAV
account migration test all pass. The calendar echo overlap was composed across
Google, CalDAV, and Apple: when `isEcho` is true, provider VALARM data from the
aligned push does not move the local reminder; non-echo inbound changes still
use the normal provider-reminder path. The echo fixture removes the unrelated
household default before inserting its one explicit reminder, so it tests the
contract rather than test setup order.

Version metadata is synchronized at `2.77.1` in the root package, both root
lockfile fields, `public/sw.js`, and current release metadata. Focused
validation passed for the waste, Google local-day, health, wall, budget,
restore/rekey, backup, CalDAV, series-end, housekeeping, read-only UI,
migration, schema-reconcile, suite-chain, and changelog suites; the
restore/rekey suite had 15 passed and 1 environment-specific skip, with 0
failures. The two local-day suites were added to the main npm test chain, and
the intentional custom v2.77.1 release-note difference is recorded in the
released-section guard. `git diff --check` is clean. The detached full
`npm test` completed with exit code 0 on 2026-10-15 (the baseline includes the
project's existing environment-specific skips). The temporary integration
branch is ready to fast-forward into `custom` and push both `main` and
`custom` without force.
