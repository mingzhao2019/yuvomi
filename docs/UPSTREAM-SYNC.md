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

Last verified: **2026-11-07 UTC**. Local `main` and `upstream/main`
are both at the `v2.86.0` upstream tip. The selective integration is complete on
`custom-upstream-selective-2026-11-07`; it is ready for a fast-forward into
`custom`. The `origin/main` and `origin/custom` tracking refs still point
to the pre-sync delivery until an explicitly authorized push.

| Reference | Commit | Meaning |
| --- | --- | --- |
| `main`, `upstream/main` | `9ae0bdc4f5e9dc76f065ee7ea89dfb1ee317ea75` | Local upstream-compatible baselines match the current upstream tip. |
| `origin/main` | `8d8f6237ba34fcb2a3f34acfa58af7c80e3be746` | Remote baseline before this synchronization; not pushed yet. |
| `custom` | `3d6390366d15febebf389ed905f15151e6edbfea` | Product branch before this synchronization; the integration branch is ready to fast-forward it. |
| `custom-upstream-selective-2026-11-07` | current integration HEAD | All 39 upstream commits after `8d8f6237` plus manual reconciliation are incorporated. |

All 39 upstream commits after the previous verified tip were incorporated in
order; none was skipped:

1. `030defba` — display night hours and screensaver settings.
2. `816e3056` — require the OpenAPI client contract to grow only.
3. `a97dd978` — keep foreign CalDAV recurrence rules from being ended.
4. `5ad12929` — record shopping purchase price history.
5. `464cf6d4` — keep foreign recurring series running when ticked off.
6. `7c61ea98` — let an installed iOS app reach the bottom edge.
7. `97bb4592` — keep CardDAV cards with empty/shared numbers separate.
8. `c1ac7d5b` — stop reminders for provider-cancelled calendar events.
9. `284dfeca` — rate-limit administrator backup downloads.
10. `c44704b6` — localize family-member settings errors.
11. `438dc07a` — prevent series names from covering health bars.
12. `10e5236c` — use the household week start in date pickers.
13. `db14bde7` — make date pickers follow the stored week start.
14. `351af1ac` — decay late reward completions without dropping below one point.
15. `8130f425` — explain sign-in and account-form failures.
16. `921f037c` — explain wall-display settings failures.
17. `817e6b66` — move kitchen search into the mobile tab bar.
18. `bfce4ca7` — explain calendar/contact sync-form failures.
19. `0ed564a6` — pin the compact kitchen search test contract.
20. `5e3dd30a` — explain backup, system, and API settings failures.
21. `d9774d04` — report when an ICS subscription delivers no event.
22. `0bae2507` — upload a newly targeted local event immediately after save.
23. `6663b0cc` — detect locale values whose characters were lost.
24. `32bf6e74` — make deployment secrets optional in every descriptor.
25. `1c0f5757` — mirror Mealie steps as plain text and provider servings.
26. `32994b3c` — discard damaged backups instead of handing them out.
27. `5409824c` — document YunoHost and the Proxmox install helper.
28. `6045d053` — use full-width question marks in Chinese and Japanese.
29. `02465e2f` — preserve the left margin of social/OG assets.
30. `20bb3ada` — keep option letters only in the step-by-step install list.
31. `a270e61c` — localize category-manager and settings errors.
32. `1d2ee2b4` — keep the pantry product suite alive across a blocked loop.
33. `523cf63a` — require real translations for new locale values.
34. `0e00f635` — accept long CardDAV app passwords without trimming them.
35. `751ecfec` — preserve the primary assignee on partial task PUTs.
36. `f535e558` — keep the database on the Docker `/data` volume.
37. `67ca3d82` — update the notes probe for the translated rename conflict.
38. `52baadf9` — cover the end edge of the mobile kitchen search zone.
39. `9ae0bdc4` — release metadata for v2.86.0.

The integration preserved custom task-list/Microsoft To Do behavior, provider
calendar contracts, notification ownership, mobile layout, device pairing,
and split-guest boundaries. Conflicts were merged semantically: the custom
CalDAV task-list mapping, Microsoft To Do path, reminder handling, and Outlook
flush path remain; the upstream shared immediate-upload helpers are used for
Google/CalDAV/Apple. Upstream schema additions remain append-only as custom
migrations v285–v289: display settings (upstream v278), foreign task recurrence
(upstream v279), shopping purchases (upstream v280), provider cancellation
status (upstream v281), and late-reward audit fields (upstream v282). Recipe
documentation retains the custom planning note while adding the upstream plain
text/servings behavior. Locale and release-document conflicts retain existing
custom translations and copy while adding all upstream keys and v2.86.0
metadata. No upstream commit was skipped.

No automated tests were run because the user explicitly requested no Test.
Static checks only: `git diff --check`; JSON parsing for package, lockfile,
and all locale files; `node --check` on changed JavaScript; release-version
consistency; strictly increasing, unique migration versions; and no unresolved
conflict markers. Focused and full test results are unverified for this
integration.

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
