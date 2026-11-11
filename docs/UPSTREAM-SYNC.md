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

Last verified: **2026-11-11 UTC**. Local `main` is fast-forwarded to
`upstream/main` at `b9626ff17369686be778b1abb8cc20af9218b35b`. The selective
integration branch was validated and fast-forwarded into `custom` at
`51ca6c824`; the final remote push is performed only after the explicit
operator authorization required by the sync skill.

| Reference | Commit | Meaning |
| --- | --- | --- |
| `main`, `upstream/main` | `b9626ff17369686be778b1abb8cc20af9218b35b` | Local upstream-compatible baseline matches the current upstream tip. |
| `custom` | `51ca6c824` | Product branch after semantic upstream integration and focused validation. |
| `origin/main`, `origin/custom` | verified before this push | Remote refs are updated together after explicit authorization. |
| temporary integration | `custom-upstream-selective-2026-11-11` | Already fast-forwarded into `custom`; remove after the final push verification. |

The integration includes upstream through `b9626ff`, including the large
app-wide polish commit `72db19dfb`, while preserving the custom task-list and
Microsoft To Do paths, bidirectional Outlook behavior, Google/CalDAV/ICS
provider contracts, local calendar display customization, notification
ownership, mobile layout, device pairing, and split-guest boundaries. The
background sender keeps the custom shared fan-out architecture and now uses
the upstream guarded fetch at the actual provider bottleneck.

The upstream recipes and split-expense migration definitions were appended as
local migrations 290 and 291; released custom migrations remain in their
original positions. The budget-category routes and tests, calendar color
picker, account labels, complete locale key set, Pantry product semantics, and
the notification fetch guard were all reconciled and validated.

Focused validation was run as requested; the full `npm test` suite was not
run. Passing groups include build, task routes (94), permissions (29 server +
14 UI), medication scheduler (24), readiness (8 plus one expected skip),
system diagnostics (10), split-expense routes (135), calendar, local calendar
management (37), color picker (10), Pantry UX (47), auth pages (21), budget UI
(264), budget read-only UI (69), i18n (87), migration append-only (4), and
dashboard calendar selection (18). `git diff --check`, JSON parsing,
JavaScript syntax checks, and conflict-marker scans also passed.

The standalone browser toolbar suite remains environment-blocked because the
bundled Chrome cannot load `libglib-2.0.so.0`; the frontend-audit suite was
stopped after running without output for an unreasonable duration. Neither
was reported as a code pass. Product-specific behavior remains authoritative
on `custom`; the full list is maintained in [`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md).

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
