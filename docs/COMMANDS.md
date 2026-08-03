# Git-Print · Command Reference

> Fetch a GitHub PR and render it into clean Markdown files — no web UI clutter, just the content.

---

## Quick Setup

- [ ] **Install dependencies**
  ```bash
  npm install
  ```

- [ ] **Build the CLI**
  ```bash
  npm run build
  # compiles TypeScript (src/) → dist/
  ```

- [ ] **Install the `git-print` command**
  ```bash
  node dist/cli.js install     # from this clone (idempotent; also sets up hooks + CI)
  # or, without cloning:  npm install -g github:itstanner5216/Git-Print
  ```
  Both put a node-version-independent launcher in `~/.local/bin`. Avoid `npm link`
  — it installs into the *active* node's bin and vanishes when you switch versions.

- [ ] **Set your GitHub token** *(required)*
  ```bash
  export GITHUB_TOKEN=ghp_yourTokenHere
  # also works: GH_TOKEN or GITHUB_PAT
  ```
  Or drop a `.env` in the repo root with `GITHUB_TOKEN` (or `GH_TOKEN` /
  `GITHUB_PAT`). git-print loads it automatically; real environment variables
  take precedence, and the file is only read, never modified.

---

## Core Commands

- [ ] **Generate both output files** *(default mode)*
  ```bash
  git-print 42
  # → .git/Git-Print/PR-42-review.md   (full conversation)
  # → .git/Git-Print/PR-42-report.md   (CI checks, commits, changed files)
  ```

- [ ] **Review file only** — conversation, comments, metadata
  ```bash
  git-print 42 --review-only
  # → PR-42-review.md
  ```

- [ ] **Report file only** — CI checks, failure annotations, file list, commits
  ```bash
  git-print 42 --report-only
  # → PR-42-report.md
  ```

- [ ] **Pass token inline** *(overrides env var)*
  ```bash
  git-print 42 --token ghp_yourTokenHere
  ```

- [ ] **Run from a different directory** *(useful in scripts)*
  ```bash
  git-print 42 --dir /path/to/your/repo
  ```

- [ ] **Show help**
  ```bash
  git-print --help
  ```

---

## Conflict Resolution

> Triggered automatically when a PR has merge conflicts — Git-Print generates a `PR-{n}-conflicts.md` file.  
> Use the flags below to resolve and commit the merge.

- [ ] **Accept the base branch version of a file**
  ```bash
  git-print 42 --use-baseline src/config.ts
  ```

- [ ] **Accept the PR's incoming version of a file**
  ```bash
  git-print 42 --use-incoming src/utils.ts
  ```

- [ ] **Mix strategies — resolve multiple files in one command**
  ```bash
  git-print 42 --use-baseline src/config.ts --use-incoming src/utils.ts
  ```

- [ ] **Auto-resolve when only one file conflicts** *(omit the filename)*
  ```bash
  git-print 42 --use-incoming
  # or
  git-print 42 --use-baseline
  ```

- [ ] **Resolve conflicts AND generate output files**
  ```bash
  git-print 42 --use-incoming src/utils.ts --review-only
  ```

> **Resolution safety:** Changes are validated in a sandboxed git worktree first.  
> Your working tree is only modified after the validation passes. Aborts cleanly on any mismatch.

---

## Automation & CI

> Subcommands for wiring git-print into your repos and CI. These don't take a PR
> number — they operate on registered repos or the current repo.

- [ ] **Install everything** *(idempotent — safe to re-run any time)*
  ```bash
  git-print install
  # • installs a node-version-independent `git-print` launcher on your PATH
  #     (~/.local/bin, or $GIT_PRINT_BIN_DIR) — a symlink to the built CLI
  # • installs a pre-push conflict hook
  # • writes the CI-failure reporter workflow into each REGISTERED repo:
  #     .github/workflows/git-print-ci-status.yml
  # flags: --cli-only (launcher only) · --ci-only (workflow only) · --dry-run
  ```

- [ ] **(Re)write only the CI reporter workflow** *(skip hooks/gitignore)*
  ```bash
  git-print install --ci-only
  ```

- [ ] **Preview an install without writing anything**
  ```bash
  git-print install --dry-run
  # combine: git-print install --ci-only --dry-run
  ```

- [ ] **Remove the hook + CI reporter workflow**
  ```bash
  git-print uninstall
  ```

- [ ] **Auto-detect local merge conflicts** *(invoked by the git hook)*
  ```bash
  git-print auto
  # silent when clean; on conflicts writes a conflicts report (and links the PR
  # if a GitHub token is available)
  ```

- [ ] **Render a CI-failure report** *(run by the reporter workflow)*
  ```bash
  git-print ci-status --pr 42 --out report.md
  # options:
  #   --pr <n>           PR number                          (required)
  #   --sha <sha>        pin checks to the commit that failed
  #   --out, -o <file>   output path         (default: Git-Print-CI-Status.md)
  #   --repo owner/repo  override repo detection (else $GITHUB_REPOSITORY / remote)
  #   --token <token>    GitHub token        (else env / repo .env)
  ```
  > The reporter workflow runs this on a failed CI run and uploads the result as
  > a build artifact — no daemon, no polling. The report includes CI status,
  > failure annotations, extracted job-log error output, changed files, and commits.

---

## Output Files

| File | What's inside |
|------|---------------|
| `PR-{n}-review.md` | Title, description, sidebar metadata, all comments/reviews/inline threads (numbered in scroll order), checks summary, merge status |
| `PR-{n}-report.md` | CI check details with failure annotations and file context, changed files sorted by status, commit history |
| `PR-{n}-conflicts.md` | Per-file conflict regions — baseline vs. incoming content, context lines, classification, and resolve command hints |

Output is always written to: `.git/Git-Print/PR-{n}-{type}.md`  
*(works correctly inside git worktrees)*

---

## Build & Dev Scripts

- [ ] **Compile TypeScript**
  ```bash
  npm run build
  # runs: tsc  (src/ → dist/)
  ```

- [ ] **Run the compiled CLI directly** *(without global link)*
  ```bash
  node dist/cli.js 42
  ```

---

## Tests

> Tests live in `tests/`. The `.mjs` tests import the compiled build, so run
> `npm run build` first.

- [ ] **Unit tests** — comment body cleaning logic
  ```bash
  npm run build && node tests/test-clean-body.mjs
  ```

- [ ] **Fixture test** — full PR renderer output contract
  ```bash
  npm run build && node tests/test-render-fixture.mjs
  ```

- [ ] **Integration tests** — conflict detection & resolution *(8 scenarios)*
  ```bash
  npx tsx tests/test-conflicts.ts
  ```

---

## Token Resolution Order

Git-Print looks for your GitHub token in this order:

1. `--token <value>` CLI flag
2. `$GITHUB_TOKEN` env var
3. `$GH_TOKEN` env var
4. `$GITHUB_PAT` env var
5. The same keys in a `.env` file at the repo root (and the current directory)

The `.env` file is only read when the env vars above are unset — real
environment variables always win. `export KEY=value` lines are supported, and
the file is never modified.

---

## Notes

- **Remote auto-detected:** reads `git remote get-url origin` — supports HTTPS, SSH, and SCP-style URLs
- **Rate limit aware:** automatically waits and retries when GitHub rate limit is near
- **stdout = file paths, stderr = progress/errors** — composable in shell pipelines:
  ```bash
  FILES=$(git-print 42) && cat $FILES
  ```
- **No runtime dependencies** — zero production npm packages; only Node.js built-ins and the GitHub API
