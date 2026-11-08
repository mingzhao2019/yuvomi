# Upstream synchronization

`custom` is a maintained product branch, not a thin fork. It shares the
upstream Yuvomi base, but its data models, routes, synchronization rules, and
UI surfaces include intentional product-specific behavior. The preservation
checklist for that behavior is [`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md).

This document contains the durable synchronization workflow and the current
repository topology. Dated integration logs are intentionally not kept here:
the commit history is the audit trail, and operational checkpoint notes older
than the seven-day retention window are removed during documentation cleanup.

## Branch roles

- `main` is the upstream-compatible baseline and follows `upstream/main`.
- `custom` contains product-specific behavior and is used for development,
  deployment, and releases.
- `upstream` is the public Yuvomi remote used to refresh `main`.
- `origin` is the personal remote. Keep both `main` and `custom` aligned with
  their corresponding local branches after an explicitly authorized push.
- Never replace `custom` wholesale with `upstream/main`.

## Current repository state

Last verified: **2026-11-08 UTC**. Local `main` was fast-forwarded to
the current `upstream/main` tip. The selective integration branch containing
the eight upstream commits was fast-forwarded into `custom`, pushed, and
removed after validation.

| Reference | Commit | Meaning |
| --- | --- | --- |
| `main`, `upstream/main` | `a17ff0884241b46de25c931b31ecbc0c995e7ef0` | Local upstream-compatible baseline matches the current upstream tip. |
| `origin/main` | `a17ff0884241b46de25c931b31ecbc0c995e7ef0` | Remote main matches the local upstream-compatible baseline. |
| `custom`, `origin/custom` | current branch tip (`2b0778de7` before this record update) | Product branch and remote delivery contain the selective integration and manual reconciliation. |
| temporary integration | removed after fast-forward | The dated selective branch was merged into `custom` and deleted locally. |

The eight upstream commits were incorporated in order:

1. `e359fad0` — read the member role from the database for every auth request.
2. `e49f6b44` — keep Health medication reminders away from members without Health.
3. `1c64964c` — keep feeds empty when the member lacks the module.
4. `8d769ff4` — guard client responses against raw exception text.
5. `6bbcd820` — classify DAV server errors for the browser.
6. `c6542ed7` — classify calendar sync and lookup failures.
7. `c8ccb6dc` — classify backup, document, and expense failures.
8. `a17ff088` — prevent stored and indirect error results from carrying raw text.

The integration preserves the custom task-list and Microsoft To Do paths,
bidirectional Outlook behavior, Google/CalDAV/ICS provider contracts, local
calendar display customization, notification ownership, mobile layout, device
pairing, and split-guest boundaries. Health medication fan-out keeps the
upstream module permission check while explicitly selecting only the
recipient's personal channels; household channels never receive Health
reminders. Notification, Outlook, split-expense, and document error paths
retain custom permission/ownership semantics while using fixed client-facing
500 responses for unexpected failures.

The upstream background-sender guard was adapted to the custom shared
fan-out architecture: medication and task routes select recipients, while
`notifications.js` is the actual provider-sending bottleneck. The upstream
`budget_category` test block was not retained because its required earlier
schema/route feature is absent from this selective custom baseline; the
current expense error-response guard remains and passes. A pre-existing
duplicate OpenAPI fragment in `server/openapi/paths/preferences.js` was
removed after it blocked module loading; it was not an upstream feature
change. No upstream correctness/security commit was skipped.

Focused tests were run as requested; the full `npm test` suite was not run.
Passing groups include auth (4), medication (23), module-feed/error guards
(25/6), module install (96), backup routes (31), split-expense routes (128),
backup scheduler/WebDAV (10 with 1 skip/19), documents/storage (3/87), DMS
Papra (14), email/HTTP/modules (28/28/44), notifications (64), recipe
adapters (41/20), calendar routes (188), subscriptions (42), sync forms (10),
waste routes (88), CalDAV account password (6), Google Calendar (57), Outlook
Calendar (48), and Outlook event targets (6). Static checks also passed:
`git diff --check`, JSON parsing for changed JSON, and `node --check` for
changed JavaScript.

Two focused suites retain known custom-baseline failures unrelated to this
sync's error-classification changes: recipe-provider-sync (21 failures because
the custom schema lacks `recipes.servings`) and caldav-http-refusals (9
existing outbound move/retry assertions; the new error-response cases pass).
These are recorded rather than expanded into unrelated earlier feature
backports.

The temporary integration branch was fast-forwarded into `custom` only after
the final local verification and was then removed. Product-specific behavior
remains authoritative on `custom`; the full list is maintained in
[`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md).

## Custom boundaries to preserve

Before adopting an upstream change, read [`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md)
and check the affected behavior rather than selecting a whole file from one
side of a conflict.

- Persistent task lists, source/list identity, Microsoft To Do mapping, and
  Markdown task checklists are separate contracts.
- Outlook, Google, CalDAV, and ICS calendars retain their provider-specific
  identity, reminder, timezone, conflict, and read-only rules.
- Personal and household notification channels have separate configuration,
  permissions, templates, and recipient scopes.
- Inventory/assets reuse the existing API, database, permissions, visibility,
  images, and dashboard widgets.
- Desktop/mobile layout slots, search entry points, visibility checks,
  timezone handling, and existing `/api/v1` contracts must remain intact.
- Database migrations are append-only. Never rewrite a released migration or
  silently move custom behavior into an upstream-only schema.

## Selective synchronization workflow

1. Confirm a clean worktree, inspect the branch topology, and verify both
   remote identities. Do not hide unexplained local changes.

2. Refresh only local `main` and fast-forward it to the upstream tip:

   ```bash
   git fetch upstream
   git switch main
   git merge --ff-only upstream/main
   git rev-parse main upstream/main
   ```

   The two hashes must match. If fast-forwarding is impossible, stop and
   resolve the divergence explicitly; do not reset, rebase, or force-update
   `main`.

3. Create a dated integration branch from the current `custom` branch:

   ```bash
   git switch custom
   git switch -c custom-upstream-selective-YYYY-MM-DD
   ```

   If that name already exists, inspect its ownership and state. Do not reuse
   an unknown branch.

4. Review every upstream commit in order. Classify each as a correctness or
   security fix, independent feature, coupled feature, duplicate, or truly
   unnecessary change. Cherry-pick only independent changes. Port coupled
   changes manually and preserve the custom boundaries above.

5. For every overlap, inspect migrations, API fields and errors, permissions,
   visibility, synchronization identity, conflicts, timezones, reminders, and
   desktop/mobile behavior. Record the decision in the integration commit or
   its review notes; never silently drop a fragment.

6. Validate on the integration branch before merging it into `custom`:

   ```bash
   git diff --check
   git diff --stat custom...HEAD
   git log --oneline --decorate custom..HEAD
   ```

   Run focused tests for affected modules by default. Run the full `npm test`
   only when the operator explicitly requests it. Check version consistency,
   and explicitly confirm task lists, Microsoft To Do, Outlook/ICS calendars,
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

## Documentation ownership and retention

These files are long-lived references and are not treated as disposable sync
logs:

- [`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md) — product-specific differences and
  the preservation checklist.
- [`SPEC.md`](SPEC.md) — data models, API semantics, and product contracts.
- [`DECISIONS.md`](DECISIONS.md) — durable design decisions and their reasons.
- [`ROADMAP.md`](ROADMAP.md) — undated product direction, not a stale task
  queue.
- [`CHANGELOG.md`](../CHANGELOG.md) — published release history; historical
  entries must not be rewritten.
- [`awesome-selfhosted/yuvomi.yml`](awesome-selfhosted/yuvomi.yml) — the
  submitted catalog entry, not an external-status log.

Only transient synchronization/status notes belong in the seven-day cleanup
window. The old upstream checkpoints and the dated external submission status
note were removed from the working documentation; their prior contents remain
recoverable from Git history.
