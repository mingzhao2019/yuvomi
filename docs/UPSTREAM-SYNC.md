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

Last verified: **2026-11-01 UTC**; this integration was initiated on
2026-10-31 UTC.

| Reference | Commit | Meaning |
| --- | --- | --- |
| `main`, `upstream/main`, `origin/main` | `93d2fec553b7bb013e9ebffd92a16b22b5dc9efa` | Local and remote upstream-compatible baselines are synchronized to the current upstream tip. |
| `custom` | Selective integration of 31 upstream commits, plus local reconciliation and this synchronization record. | Product-specific behavior remains authoritative. |
| `origin/custom` | Will match local `custom` after the explicitly authorized delivery push for this sync. | Remote delivery is part of this workflow. |

After the authorized delivery push, both branch pairs are expected to match:

```text
main...upstream/main   0 0
custom...origin/custom 0 0
```

The release metadata remains `2.83.0`. All nine upstream commits after the
previous synchronization point were incorporated on the temporary branch:

1. `01292d50` — documents can name a person and expose key dates.
2. `8e963706` — clarify self-update scope and add Proxmox bug-form guidance.
3. `5583ef64` — quote the Quadlet health-check node command.
4. `732c1d52` — keep a wall meal until the next planned meal starts.
5. `a3bee52c` — keep the iPhone list tail above the menu.
6. `6f3475e4` — prevent feedback undo-probe regex backtracking.
7. `0e383175` — persist task grouping after reload.
8. `dc611863` — keep sync snapshots out of calendar event responses.
9. `9d3b5244` — restore ICS feed values when resetting a subscription.

The integration preserved the custom contracts while reconciling the wall
timeline with upstream R24, task sync/resizer behavior, calendar provider and
Outlook contracts, the package test chain, Vietnamese locale duplicates, ICS
migration lookup, task date formatting, translated-i18n baselines, OpenAPI
reason codes, health and waste late-modal context for #1997, motion tokens and
baselines, control-dialect thresholds, hidden-cascade rules, and the wall
event-limit expectation. Documents remain at local migration v279 over
upstream v272; ICS subscriptions remain at local migration v280 over upstream
v273. Both migrations are append-only.

Focused checks passed: i18n 82/82 and translated i18n 104/104, dashboard event
limit 44/44, frontend audit 563/563, health errors 58/58, waste errors 114/114,
ICS subscription 40/40, motion 110/110, control dialect 120/120, and hidden
cascade 37/37. The explicitly requested complete `npm test` run exited `0`;
the log contains no `not ok` entries or non-zero `# fail` summaries.

There is no temporary integration branch left in the local repository.
Product-specific behavior remains authoritative on `custom`; the full list is
maintained in [`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md).

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
