# Upstream synchronization

The `custom` branch is a maintained product branch, not a thin fork. It shares the upstream Yuvomi
base, but several important areas have different data models, routes, synchronization semantics,
and UI implementations. In particular, task lists, Microsoft To Do, and notification channels are
not safe to update by replacing files with their upstream versions.

The maintained inventory of custom behaviour and preservation boundaries is in
[`docs/CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md). Use it as the checklist when
reviewing an upstream change.

## Branch roles

- `main` is the upstream-compatible base branch.
- `custom` is the branch used for our development and releases.
- `upstream` points to the public Yuvomi repository and is used for review only.

## Release version rule

`custom` follows the current version of the local `main` branch after an upstream
sync. Read the version from `main:package.json` and keep the root version in
`package.json`, the two root package entries in `package-lock.json`, and
`public/sw.js`'s `APP_RELEASE` identical. Current baseline: `2.69.1`.

Update current-release references in installation/landing metadata as part of
the same change, but keep historical `CHANGELOG.md` entries unchanged. A
version mismatch is a release defect, not a browser-cache issue.

Keep the remote configured once:

```bash
git remote add upstream https://github.com/ulsklyc/yuvomi.git
git fetch upstream
```

If `upstream` already exists, fetch it instead of adding it again.

## Selective update workflow

1. Fetch the upstream refs and compare `upstream/main` with the custom base.

   ```bash
   git fetch upstream
   git log --oneline --decorate custom..upstream/main
   git diff --stat custom..upstream/main
   ```

2. Classify each candidate as a bug fix, security fix, independent feature, or a change coupled to
   an upstream data/UI implementation. Security and correctness fixes receive priority; coupled
   changes need a manual port.

3. Create an integration branch from `custom` and port one coherent change at a time.

   ```bash
   git switch custom
   git switch -c upstream/<short-description>
   ```

   A clean `cherry-pick` is acceptable for a genuinely independent commit, but it is not evidence
   that the surrounding feature is compatible. For coupled changes, reproduce the behavior in the
   custom implementation and write or adapt regression tests.

4. Review the full diff for migrations, API contracts, permissions, synchronization identity, and
   responsive UI behavior. Run the focused tests for the affected module and the repository checks
   before merging the integration branch into `custom`.

5. Record the upstream commit or release, the adapted files, and any intentionally skipped pieces
   in the commit body or change log. Do not rewrite existing migration numbers or silently drop a
   custom compatibility layer.

## What not to do

- Do not rebase `custom` directly onto `upstream/main` as a routine update.
- Do not replace custom files with upstream copies just because their paths match.
- Do not assume an upstream PR or release includes the custom data migrations.
- Do not merge an upstream feature until its permissions, sync behavior, and mobile/desktop UI have
  been checked against this branch.

The goal is a deliberate, reviewable flow of selected upstream improvements while keeping the
custom branch's contracts and existing installations stable.

## Sync record: 2.69.1

Source baseline: `main:package.json` at `2.69.1` (2026-09-23). The integration branch started at
`custom` commit `88146b3a3`; the upstream checkpoint was `origin/main` commit `036f48860` (#1429).
Commits through that checkpoint were already represented in the starting custom tree and were not
replayed. All 24 commits after the checkpoint are accounted for below.

| Upstream commit | Decision |
| --- | --- |
| `082a5e57c`, `6d1c7ca99`, `bdde8b3c0`, `0074474e6` | Adopted linked-contact email ownership, case-insensitive matching, isolated tests, and token-scope checks. Kept custom contact permissions and email normalization. |
| `5f539bf16`, `f2f3af8e2` | Adopted contact-to-guest identity and atomic creation after password hashing; retained the custom guest mapping, generated password, and contact artifacts. |
| `3bbe2d5d2` | Adopted source-module read checks across linked records and transfers, including Inventory, Budget, Pantry, Shopping, Recipes, Contacts, and split-expense candidates. |
| `49600ea3f` | Adopted toast, dialog, 2FA, and read-only interaction fixes. |
| `4e6150705` | Adopted the restored-page `pageshow` probe fix. |
| `d1e30ee77` | Adopted linked-document read-right enforcement. |
| `d916c7a4d` | Adopted SSO email normalization and skipped-dose timestamp correction; retained the same normalized address rule for password reset. |
| `7ca7366f8` | Adopted split-ledger rebuilding after account deletion; appended migration `v235` after custom migrations `v225`-`v234`. |
| `5e130012e` | Ported the calendar assignment review one moved event at a time, preserving custom assignment behavior. |
| `7073efbc2` | Ported the CalDAV legacy-color cleanup without replacing custom calendar, Outlook, or ICS flows. |
| `fa7488937` | Ported atomic backup replacement and damaged-backup refusal, preserving tracking for custom Outlook and Microsoft To Do sync tasks. |
| `5e4d968d3` | Adopted CardDAV admin-only account management and password re-entry when the server origin or username changes. |
| `5264bd59b` | Adopted secure SSO email linking, ambiguity refusal, and duplicate-address guards; adapted split-expense checks to custom guest transactions. |
| `57d09c46a` | Adopted the SSO administrator guidance and updated the environment, security, installation, and specification docs. |
| `5b1ad1960` | Adopted release `2.69.1` metadata, including package, lockfile, service worker, install examples, and release dates. |
| `f80e44c23` | Adopted the four UI system rules added to `DESIGN.md` after the release tag. |
| `f4b8f0759`, `fce4641c3` | Did not import intermediate release versions or stale release metadata. Manually ported the still-current Nutrition model, page, and API documentation from the `fce4641c3` specification change; final version metadata comes from `5b1ad1960`. |
| `1f0ead970`, `a03e4cb9c` | Did not cherry-pick release merge commits; their component commits and release metadata are handled individually above, leaving no extra semantic changes. |

No commit after checkpoint `036f48860` remains deferred. No upstream branch merge or push was
performed.

## Microsoft To Do compatibility boundary

Microsoft To Do `steps`/`checklistItems` are intentionally not imported or exported as Yuvomi subtasks. A To Do step is a nested checklist entry without its own task identity, visibility, permissions, or parent-task relationship; Yuvomi subtasks are real tasks and participate in those models. Any upstream change that assumes the two are interchangeable must therefore be adapted or skipped during selective synchronization.
