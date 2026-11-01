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

Last verified: **2026-11-02 UTC**. This integration refreshed `main` to the
current upstream tip and prepared the corresponding selective update for
`custom` on `custom-upstream-selective-2026-11-02`.

| Reference | Commit | Meaning |
| --- | --- | --- |
| `main`, `upstream/main` | `2dc9bfe7820e58fa947d20f82d5cf102065a1eb0` | Local upstream-compatible baselines match the current upstream tip. |
| `origin/main` | `93d2fec553b7bb013e9ebffd92a16b22b5dc9efa` before delivery | The explicitly authorized delivery push advances it to the local `main` tip. |
| `custom` | `208c411d46212b296ef0dc6d77f144bc126ded52` before delivery | The selective integration is fast-forwarded into this product branch after review. |
| `origin/custom` | `208c411d46212b296ef0dc6d77f144bc126ded52` before delivery | The explicitly authorized delivery push advances it to the resulting local `custom` tip. |
| temporary integration | `custom-upstream-selective-2026-11-02` | Contains the 16 upstream commits plus local reconciliations; it is removed after the fast-forward. |

After the authorized delivery push, both branch pairs are expected to match:

```text
main...upstream/main   0 0
custom...origin/custom 0 0
```

The release metadata remains `2.83.0`. All 16 upstream commits after the
previous synchronization point (`93d2fec553b7bb013e9ebffd92a16b22b5dc9efa`)
were incorporated on the temporary branch:

1. `c3455255` — harden the Docker container with `no-new-privileges`.
2. `7dda1ee9` — restrict notification channel routes to their owner/scope.
3. `93f811f4` — accept convertible health units and read converted limits.
4. `4b0ddb0d` — make the web app manifest network-first.
5. `93c80c5d` — preserve sub-second precision when aligning calendar series.
6. `b9094912` — preserve local time for repeating CalDAV tasks.
7. `c4d4ba80` — keep task titles whole on phones below 390px.
8. `a2343182` — keep the dashboard today summary within its card.
9. `869e0291` — prevent settings toasts from exposing raw error text.
10. `f7dbd295` — keep budget titles whole on phones below 390px.
11. `6b8b0393` — deduplicate shared-event reminders per channel.
12. `9052d4a8` — deduplicate waste-pickup reminders per channel.
13. `ef1ef514` — document a native iOS client beside Yuvomi.
14. `11d84a48` — name the product and client contract in `/version`.
15. `789029b7` — add signed-in device credentials for native clients.
16. `2dc9bfe7` — add upcoming reminders for native clients.

The integration preserved the custom contracts while reconciling notification
ownership, locale/settings merges, mobile task and budget layout, health unit
conversion, calendar/CalDAV precision, device credentials, and upcoming
reminders. The custom `/pending` reminder route keeps its completed-task
suppression while the new `/upcoming` route uses the upstream shared query.
Because custom migrations already use v274 through v280, the device-credential
migration was appended as v281; released migrations remain untouched.

No automated tests were run by explicit user request. Static checks only:
`git diff --check`; JSON parsing for package, lockfile, and locale files;
`node --check` on changed production JavaScript files; strictly increasing,
unique migration versions; and no unresolved conflict markers. Focused and full
test results are unverified for this integration.

The temporary integration branch is fast-forwarded into `custom` only after
the final local verification and is then removed. Product-specific behavior
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
