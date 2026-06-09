---
id: release
name: Bandit Release Flow
description: Use when the user asks to ship, release, publish, cut, or bump a version of bandit-stealth-cli / bandit-stealth / the chart
activation: auto
triggers: [release, ship, publish, "cut a release", "bump version", "new version", "1.5.", "0.2."]
---

# Bandit Release Flow

This monorepo ships three artefacts in lockstep. If you touch one version number, you almost always touch all three. Walk the user through them in order; do not stop mid-flow.

## The three artefacts

| Artefact | File | Current source of truth |
|----------|------|-------------------------|
| CLI package | `apps/bandit-cli/package.json` — `version` | Published to GitHub Packages as `@burtson-labs/bandit-stealth-cli` |
| VS Code extension | `apps/bandit-stealth/package.json` — `version` | Published to the VS Code Marketplace + Open VSX |
| Helm chart | `apps/bandit-stealth-web/charts/bandit-stealth-web/Chart.yaml` — both `version` and `appVersion` | Controls the web deploy |

CLI + extension share the same version number (e.g. both `1.5.32`). The chart tracks on its own cadence (`0.2.x`). Increment the patch digit unless the user is explicitly calling out a minor or major.

## Step-by-step playbook

When the user says "release", "ship 1.5.N", "bump version", etc:

1. **Read the current versions.** Open all three files with `read_file`. Confirm what bump is expected. Do not guess the next number — state "current is X, proposing X+1" and wait for confirmation if the user hasn't given an explicit number.

2. **Apply the bumps.** Use `apply_edit` (not `write_file` — these are one-line changes):
   - `apps/bandit-cli/package.json`: find `"version": "<old>"` → replace with `"version": "<new>"`
   - `apps/bandit-stealth/package.json`: same pattern
   - `apps/bandit-stealth-web/charts/bandit-stealth-web/Chart.yaml`: bump BOTH `version:` and `appVersion:` on the same chart number

3. **Rebuild the CLI.** `run_command npm run build` with `cwd="apps/bandit-cli"`. The published CLI is bundled — the version shown in the launch banner and reported by `/update` comes from the bundled `package.json`, so skipping this step means the registry gets 1.5.N published but users see 1.5.N-1 in the banner.

4. **Run the smoke test.** `run_command node dist/__smoke__/smoke.js` with `cwd="apps/bandit-cli"`. It should print `✓ smoke test passed …`. If it fails, STOP — don't commit a broken release.

5. **Review the diff.** Run `git_status` and `git_diff` so the user can confirm only the intended files changed. Flag any unexpected working-tree changes and ask before proceeding.

6. **Commit.** Use `git_commit` with the established message format:
   ```
   <type>: v<version> — <one-line summary>

   <2-4 paragraph body explaining the motivation and key changes.
   The body is what shows up in the GitHub release notes, so it
   should read as a changelog entry, not an internal note.>
   ```
   Types used in this repo: `feat`, `fix`, `chore`, `bump`. No Co-Authored-By trailer — the project preference is no co-authors on commits.

7. **Push main.** `run_command git push origin main`.

8. **Tag + push the tag.** `run_command git tag v<version>` then `run_command git push origin v<version>`. The tag is what triggers the publish workflows — without it CI/CD does not publish.

9. **Verify the registry.** Wait until CI/CD completes, then `run_command npm view @burtson-labs/bandit-stealth-cli version` — it should print the new version. If it doesn't after CI says it's green, the publish job failed silently; surface that.

## What NOT to do

- Do not amend the commit after pushing. Create a fresh commit if you need a follow-up.
- Do not skip the rebuild. The version baked into `dist/cli.js` is what users see.
- Do not push `--force` to `main` without an explicit instruction from the user. If a commit needs undoing, prefer a new revert commit.
- Do not stop halfway. "Version bumped but not committed" or "committed but not pushed" are the exact incomplete-release states the user has explicitly called out before.

## Recovering from a botched release

If the publish succeeds but the bundled banner shows the wrong version (forgot step 3), immediately ship a `fix:` patch with the corrected rebuild. Do not try to overwrite the same version number on the registry — GitHub Packages doesn't allow it and the marketplace will reject a republish at the same version.
