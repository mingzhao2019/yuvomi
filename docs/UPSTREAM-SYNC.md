# Upstream synchronization

The `custom` branch is a maintained product branch, not a thin fork. It shares the upstream Yuvomi
base, but several important areas have different data models, routes, synchronization semantics,
and UI implementations. In particular, task lists, Microsoft To Do, and notification channels are
not safe to update by replacing files with their upstream versions.

## Branch roles

- `main` is the upstream-compatible base branch.
- `custom` is the branch used for our development and releases.
- `upstream` points to the public Yuvomi repository and is used for review only.

## Release version rule

`custom` follows the current version of the local `main` branch after an upstream
sync. Read the version from `main:package.json` and keep the root version in
`package.json`, the two root package entries in `package-lock.json`, and
`public/sw.js`'s `APP_RELEASE` identical. Current baseline: `2.50.0`.

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

## Microsoft To Do compatibility boundary

Microsoft To Do `steps`/`checklistItems` are intentionally not imported or exported as Yuvomi subtasks. A To Do step is a nested checklist entry without its own task identity, visibility, permissions, or parent-task relationship; Yuvomi subtasks are real tasks and participate in those models. Any upstream change that assumes the two are interchangeable must therefore be adapted or skipped during selective synchronization.
