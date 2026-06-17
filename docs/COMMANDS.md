# Git-Print · Command Reference

> Fetch a GitHub PR and render it into clean Markdown files — no web UI clutter, just the content.

---

## Quick Setup

- [ ] **Install dependencies**
  ```bash
  pnpm install
  ```

- [ ] **Build the CLI**
  ```bash
  pnpm build
  # compiles TypeScript → dist/
  ```

- [ ] **Link the binary globally** *(optional, one-time)*
  ```bash
  npm link
  # makes `git-print` available system-wide
  ```

- [ ] **Set your GitHub token** *(required)*
  ```bash
  export GITHUB_TOKEN=ghp_yourTokenHere
  # also works: GH_TOKEN or GITHUB_PAT
  ```

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
  pnpm build
  # runs: tsc
  ```

- [ ] **Run the compiled CLI directly** *(without global link)*
  ```bash
  node dist/cli.js 42
  ```

---

## Tests

- [ ] **Unit tests** — comment body cleaning logic
  ```bash
  node test-clean-body.mjs
  ```

- [ ] **Fixture test** — full PR renderer output contract *(requires a build first)*
  ```bash
  pnpm build && node test-render-fixture.mjs
  ```

- [ ] **Integration tests** — conflict detection & resolution *(8 scenarios)*
  ```bash
  # compile then run
  npx tsc test-conflicts.ts --outDir dist-test --module Node16 --moduleResolution Node16 --target ES2022 --esModuleInterop
  node dist-test/test-conflicts.js
  ```

---

## Token Resolution Order

Git-Print looks for your GitHub token in this order:

1. `--token <value>` CLI flag
2. `$GITHUB_TOKEN` env var
3. `$GH_TOKEN` env var
4. `$GITHUB_PAT` env var

---

## Notes

- **Remote auto-detected:** reads `git remote get-url origin` — supports HTTPS, SSH, and SCP-style URLs
- **Rate limit aware:** automatically waits and retries when GitHub rate limit is near
- **stdout = file paths, stderr = progress/errors** — composable in shell pipelines:
  ```bash
  FILES=$(git-print 42) && cat $FILES
  ```
- **No runtime dependencies** — zero production npm packages; only Node.js built-ins and the GitHub API
