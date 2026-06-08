#!/usr/bin/env node
/**
 * cli.ts — print-pr-review CLI
 *
 * Usage:
 *   print-pr-review <pr-number> [--token <token>] [--dir <path>]
 *                   [--review-only] [--report-only]
 *                   [--use-baseline <file>...] [--use-incoming <file>...]
 *
 * Report mode (default): generates review, report, and conflict files.
 * Resolve mode (when --use-baseline or --use-incoming present): runs the
 * resolution in a sandbox worktree to validate, then applies it to your
 * current working tree (which must be on the PR head branch).
 */
/**
 * Parse a GitHub remote URL and return { owner, repo }.
 * Supports:
 *   - https://github.com/owner/repo(.git)
 *   - https://user:token@github.com/owner/repo(.git)
 *   - ssh://git@github.com/owner/repo(.git)
 *   - git@github.com:owner/repo(.git)              (SCP-style)
 *   - github.com:owner/repo(.git)
 *
 * Crucially: a repository name like `foo.bar` keeps its dots; only ONE trailing
 * `.git` suffix is stripped.
 */
export declare function parseGitHubRemote(url: string): {
    owner: string;
    repo: string;
} | null;
