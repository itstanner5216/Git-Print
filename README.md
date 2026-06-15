# Git-Print

**One command. The entire PR — exactly as a person sees it.**

Git-Print is a CLI tool purpose-built for AI coding agents (and humans) that need to understand and act on a GitHub Pull Request — without the 15-minute, 20-API-call ordeal. One command produces a single, clean Markdown document that captures *everything*: every comment, every inline thread, every review, every merge conflict, every CI annotation — assembled in the exact scroll order you'd see on the GitHub PR page.

---

## Why This Exists

If you've ever tasked an AI agent with addressing PR review comments, you've hit the wall.

GitHub's API fragments pull request data across a dozen endpoints. Inline code review comments live separately from general review comments, which live separately from issue-timeline comments, which live separately from commit-level comments. Suggested changes are embedded in a different payload format than regular inline comments. Merge conflict data doesn't exist in the API at all — you have to run a trial merge locally to find it. CI annotations live in a third location. Bot noise pollutes everything.

The result: **your agent makes 15–20 API calls, ingests thousands of tokens of irrelevant metadata, and still ends up with a fragmented, out-of-order picture of what actually needs to change.**

Git-Print was built because nothing like it existed. After searching for a tool that could give an agent a clean, unified PR view — and finding nothing — it was built from scratch. The output is so precise and complete that agents can address every comment and every merge conflict without a single follow-up lookup.

---

## What Git-Print Does

```sh
print-pr-review 42
```

That's the entire workflow. Run it from anywhere inside your repository. Git-Print:

1. Auto-detects your GitHub remote
2. Makes all necessary API calls in parallel
3. Writes clean, structured Markdown to `.git/Git-Print/` — invisible to `git status`, scoped to the repo

**Output files:**

| File | What it contains |
|------|-----------------|
| `PR-42-review.md` | Every comment, inline thread, review, and suggested change — numbered in exact scroll order, with diff context, reviewer identity, timestamps, and resolution state |
| `PR-42-report.md` | CI check results with failure annotations and source-level markers, changed files list sorted by status, full commit history |
| `PR-42-conflicts.md` | *(only when conflicts exist)* Every conflict region with surrounding context, both sides shown side-by-side, classified by type, with exact resolve commands |

---

## The Agent Workflow, Before and After

### Before Git-Print

To give an agent full PR context:

- `GET /pulls/{n}` — metadata only, no comments
- `GET /pulls/{n}/reviews` — review summaries, no inline threads
- `GET /pulls/{n}/comments` — inline code comments, raw, out of order
- `GET /issues/{n}/comments` — general comments, separate endpoint
- `GET /pulls/{n}/files` — changed files and raw diffs
- `GET /commits/{sha}/comments` — commit-level comments, another endpoint
- Multiple `GET /check-runs` calls per commit for CI data
- Multiple `GET /check-runs/{id}/annotations` calls for failure details
- A local trial merge to detect conflict files
- Manual reconstruction of thread order, diff context, and conversation flow

**Result:** 15–20 API calls, thousands of tokens of irrelevant metadata, a fragmented non-chronological view, and an agent that still has to ask follow-up questions.

### After Git-Print

```sh
print-pr-review 42
```

**Result:** One command. One file. Zero context bloat. Agent reads the review, addresses every comment, resolves every conflict — done.

---

## The Review Output: What "Clean" Actually Means

The `PR-{n}-review.md` file isn't an API dump. It's a faithful reconstruction of the GitHub PR page as a human reads it — with all web furniture removed:

- **Every comment in scroll order** — review events, inline threads, and general comments interleaved chronologically, numbered so agents can reference them precisely
- **Inline thread context** — each thread includes the reviewer, the file path and line anchor, a line-numbered diff block showing exactly the code being discussed, and whether the thread is resolved or still open
- **Suggested changes rendered** — code suggestions appear as diff blocks showing the proposed change, not as raw API payloads
- **Bot noise stripped** — promotional footers, share links, badge images, mascots, collapsed `<details>` walkthrough blocks — gone. Human content preserved byte-faithful
- **Link policy** — link text kept, link destinations dropped (you're reading a document, not navigating a browser). URLs the author typed in prose as content stay
- **Code never touched** — content inside fences and inline backticks is never cleaned, even if it contains HTML or Markdown syntax

---

## The Merge Conflict Workflow

When a PR has conflicts, Git-Print runs a trial merge in an isolated Git worktree, extracts every conflict region with surrounding context, and writes `PR-{n}-conflicts.md`. The file classifies each conflict by type (both-modified, delete/modify, binary, submodule) and includes the exact resolve commands.

**Resolving conflicts is a single additional flag:**

```sh
# Accept the base branch version of one file, the incoming version of another
print-pr-review 42 --use-baseline config.ts --use-incoming utils.ts

# Auto-resolve when only one file conflicts (filename inferred automatically)
print-pr-review 42 --use-incoming
```

Resolution runs through a sandbox worktree before touching your working tree. Safety checks:

- Verifies you're on the correct branch before applying anything
- Pins commit SHAs to catch branch movement between fetch and merge
- Detects filename typos with fuzzy matching
- Handles partial resolution — resolve some files, leave others for manual work
- Leaves merge state intact for manual finishing when not all conflicts are resolved
- Handles file deletions, binary conflicts, and modify/delete edge cases

The agent reads `PR-{n}-conflicts.md`, runs one command per file, and creates a clean merge commit — without ever touching the GitHub web UI or making additional API calls.

---

## Installation

```sh
git clone https://github.com/itstanner5216/Git-Print.git
cd Git-Print
pnpm install
pnpm build
npm link   # makes print-pr-review available system-wide
```

**Requirements:**
- Node.js 18+ (native `fetch`, no polyfills needed)
- pnpm (build toolchain)
- Git (remote detection, conflict operations, worktree isolation)
- A GitHub token with `repo` read access

**No runtime dependencies** — zero production npm packages. Only Node.js built-ins and the GitHub REST API.

---

## Usage

```sh
# Full output: review + report (+ conflicts file if applicable)
print-pr-review 42

# Conversation and review threads only
print-pr-review 42 --review-only

# CI checks, annotations, changed files, commits only
print-pr-review 42 --report-only

# Resolve conflicts — accept incoming for all files (single-conflict shorthand)
print-pr-review 42 --use-incoming

# Resolve conflicts — mix strategies across files
print-pr-review 42 --use-baseline config.ts --use-incoming utils.ts

# Run from outside the repo directory
print-pr-review 42 --dir /path/to/my/repo

# Inline token (overrides environment variables)
print-pr-review 42 --token ghp_xxx
```

### Output Location

Files are written to `.git/Git-Print/` — inside the Git administrative directory. This means they never appear in `git status`, never get staged or committed accidentally, and are naturally scoped to the repository. Works correctly inside Git worktrees.

### Authentication

Checks in order:

1. `--token` flag
2. `$GITHUB_TOKEN`
3. `$GH_TOKEN`
4. `$GITHUB_PAT`

### Shell Composability

stdout outputs file paths. stderr outputs progress and errors. This makes Git-Print composable in pipelines:

```sh
FILES=$(print-pr-review 42) && cat $FILES
```

---

## How It Works

1. **Detect** — Finds the Git root and parses the `origin` remote to determine owner/repo. Supports HTTPS, SSH, SCP-style, and authenticated URL formats.
2. **Fetch** — Parallel API calls retrieve PR metadata (with mergeable-status polling), commits, file diffs, reviews, review comments, issue comments, check runs, CI annotations, and resolved thread state. Rate-limit aware — automatically waits and retries.
3. **Render** — Assembles data into clean Markdown following the exact visual contract of the GitHub PR page. Bot noise is stripped; code context is rebuilt; thread order is reconstructed chronologically.
4. **Write** — Outputs to `.git/Git-Print/`. Stale conflict files are cleaned up automatically when mergeability changes.

---

## License

MIT
