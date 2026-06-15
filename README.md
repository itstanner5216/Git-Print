# Git-Print

**One command. The entire PR — as a clean, readable document.**

Git-Print takes a GitHub Pull Request and renders it into plain Markdown files that capture *everything* a reviewer sees — the conversation, the code suggestions, the CI status, the commit history, the file changes, and even the merge conflicts — stripped of all web clutter, bot spam, and UI noise.

## The Problem

Reading a Pull Request on GitHub means navigating a fragmented web interface: tabs you have to click through, collapsed threads you have to expand, bot comments drowning out real feedback, badge images, promotional footers, share links, social media spam from automated reviewers — and if you want to take it offline, print it, or feed it to another tool? There is no clean way.

**The alternatives are painful:**

- **Copy-paste from GitHub** — you get raw HTML artifacts, broken formatting, embedded images, and link destinations inlined everywhere. You lose thread structure and miss collapsed content entirely.
- **GitHub's "print" view** — incomplete, loses code review threads, skips CI details, ignores merge conflict context.
- **`gh pr view`** — shows you the description and maybe the diff, but not the review conversation, not the inline code threads, not the suggested changes, not the CI annotations, not the conflict regions.
- **Export extensions/scripts** — fragile scrapers that break when GitHub changes their DOM, produce HTML soup, and miss half the data.
- **Manual reconstruction** — opening each review thread, copying each inline comment, finding the relevant diff hunk for each suggestion, noting which threads are resolved vs. active, which checks failed and why. For a substantial PR, this takes an hour of clicking.

## What Git-Print Does

```
print-pr-review 42
```

That's it. Run it from anywhere inside your repo. It auto-detects the GitHub remote, fetches all PR data via the API, and produces clean Markdown documents in your `.git/Git-Print/` directory:

| File | What it contains |
|------|-----------------|
| `PR-42-review.md` | The full conversation — every comment, every inline code review thread, every suggested change — in the exact scroll order you'd see on the GitHub PR page |
| `PR-42-report.md` | CI status with failure details and annotations, changed files list, and full commit history |
| `PR-42-conflicts.md` | *(only when conflicts exist)* Every conflict region with context, both sides shown, classified by type |

## What Makes the Output Good

Git-Print doesn't just dump API responses. It reconstructs the PR page as a human reads it:

**Conversation fidelity** — Comments are numbered in the exact order they appear when you scroll the PR page. Review events, inline threads, and general comments are interleaved chronologically — not separated into artificial "Reviews" / "Comments" / "Inline" buckets that no one reads that way.

**Inline thread rendering** — Each code review thread shows the reviewer, timestamp, severity (when bots provide it), the file path and line anchor, a line-numbered diff context block showing exactly what code is being discussed, the comment prose, and then each suggested change rendered as a proper unified diff with `@@ headers` — not the raw API suggestion blob.

**Content policy** — Every word a human reader sees on the PR page is kept byte-faithful. Every piece of web furniture is removed:
- Link text is kept; link targets are dropped (you're reading a document, not clicking)
- Bare URLs the author typed in prose stay (that's content being discussed)
- Bot promotional footers, share links, "Thanks for using X!" spam, badge images, mascot images, HTML comments, collapsed walkthrough `<details>` blocks — all gone
- Code inside fences and inline backticks is never touched — a code example that shows `<img>` or `[link](url)` syntax is preserved literally

**CI intelligence** — Failed checks don't just say "failed." Git-Print fetches annotations, pulls the relevant source lines with markers showing exactly where the error is, extracts failure-relevant log lines with context, and formats it so you can read what broke without opening a browser.

**Conflict reporting** — When a PR has merge conflicts, Git-Print runs a trial merge in an isolated worktree, extracts every conflict region with surrounding context, classifies each one (both sides modified, one side deleted, etc.), and presents base vs. incoming side-by-side with syntax highlighting.

## Conflict Resolution

Beyond reporting, Git-Print can *resolve* merge conflicts safely:

```
print-pr-review 42 --use-baseline config.ts --use-incoming utils.ts
```

This validates the resolution in a sandbox worktree first, then applies it to your working tree and creates a proper merge commit — with safety checks:

- Verifies you're on the correct branch
- Pins SHAs to catch branch movement between metadata fetch and merge
- Supports partial resolution (resolve some files, leave others for manual work)
- Detects typos in filenames with fuzzy matching
- Handles file deletions, binary conflicts, and modify/delete scenarios
- Leaves merge state intact for manual finishing when only some conflicts are resolved

## Installation

```sh
# Clone and build
git clone https://github.com/itstanner5216/Git-Print.git
cd Git-Print
pnpm install
pnpm build

# Link globally (optional)
npm link
```

## Usage

```sh
# Generate review + report + conflict files for PR #42
print-pr-review 42

# Only the conversation review
print-pr-review 42 --review-only

# Only the CI/commits/files report
print-pr-review 42 --report-only

# Resolve conflicts (single conflicting file — filename auto-detected)
print-pr-review 42 --use-incoming

# Resolve conflicts (multiple files)
print-pr-review 42 --use-baseline config.ts --use-incoming utils.ts

# Specify a different directory (auto-detects repo from there)
print-pr-review 42 --dir /path/to/my/repo

# Explicit token (otherwise reads $GITHUB_TOKEN, $GH_TOKEN, or $GITHUB_PAT)
print-pr-review 42 --token ghp_xxx
```

### Output Location

Files are written to `.git/Git-Print/` inside your repository's Git administrative directory. This keeps them out of your working tree, out of `git status`, and naturally scoped to the repo — but accessible from any worktree.

### Authentication

Git-Print needs a GitHub token with repo read access. It checks, in order:

1. `--token` flag
2. `$GITHUB_TOKEN` environment variable
3. `$GH_TOKEN` environment variable
4. `$GITHUB_PAT` environment variable

## How It Works

1. **Detect** — Finds the Git root and parses the `origin` remote to determine owner/repo (supports HTTPS, SSH, SCP-style, and authenticated URLs)
2. **Fetch** — Parallel API calls grab the PR metadata (with mergeable status polling), commits, files, reviews, review comments, issue comments, check runs, statuses, and resolved thread state via GraphQL — all in one shot, respecting rate limits
3. **Render** — Assembles the data into clean Markdown following the exact visual contract of the GitHub PR page, with bot noise stripped and code context rebuilt
4. **Write** — Outputs to the Git-Print directory, cleaning up stale conflict files when mergeability changes

## Requirements

- Node.js 18+ (uses native `fetch`)
- Git (for repo detection, conflict operations, and worktree isolation)
- A GitHub token with read access to the target repository

## License

MIT
