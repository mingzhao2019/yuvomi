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

Last verified: **2026-10-28 UTC**.

| Reference | Commit | Meaning |
| --- | --- | --- |
| `main`, `upstream/main` | `c77bc34d1be8030c88b154ffb6a85b3295077008` | Local upstream v2.82.0 baseline is synchronized through the latest two fixes. |
| `origin/main` | `548b6d0a3f1b8262133790bd3e0417c08e8ede94` | Last pushed upstream baseline; delivery of the new `main` tip is pending authorization. |
| `custom`, `origin/custom` | `3c06b9facb5a37808b97e642e6907bebd10cffe6` | Custom branch before the current selective integration. |
| `custom-upstream-selective-2026-10-28` | `0b2181e06` | Current integration branch; pending fast-forward into `custom`. |

The previous remote branch pairs matched; the current integration intentionally
leaves the new upstream tip and custom integration local until delivery:

```text
main...upstream/main   0 0
custom...origin/custom  0 0
```

The release metadata is `2.82.0`. The destructive upstream commit
`cd1ee47be` (cross-account duplicate-row deletion) remains intentionally
excluded because it conflicts with the custom task-list/account identity
contract and can delete existing data.

The new upstream commits are `aec5cf0cb` (full-cell API-token scope targets)
and `c77bc34d1` (member-colour validation and safe rendering). Both were
adopted. The upstream migration 269 became custom migration 278 because
custom already uses migration numbers 269–277; the upstream destructive
migration 268 was not adopted.

Focused checks pass: avatar colour 6/6, token scopes 16/16, dashboard 189/189,
frontend audit 563/563, and migration append-only 4/4. The full `npm test`
and the aggregate browser guard chain were not run per the operator's request;
those scopes remain unverified.

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
