#!/usr/bin/env node
/**
 * cli.ts — git-print CLI
 *
 * Usage:
 *   git-print <pr-number> [--token <token>] [--dir <path>]
 *                   [--review-only] [--report-only]
 *                   [--use-baseline <file>...] [--use-incoming <file>...]
 *
 * Report mode (default): generates review, report, and conflict files.
 * Resolve mode (when --use-baseline or --use-incoming present): runs the
 * resolution in a sandbox worktree to validate, then applies it to your
 * current working tree (which must be on the PR head branch).
 */

import { execSync, execFileSync } from "node:child_process";
import { mkdir, unlink, writeFile, readFile, chmod } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, chmodSync, statSync, mkdirSync, unlinkSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  fetchAllPRData, fetchPRMetadata, fetchAllPages, renderPR, renderReport,
  resolveConflicts, extractConflicts, gitCommonDir, parseCombinedDiffSideMap,
  buildSideLineMap, readBlobLines,
} from "./pr-renderer.js";
import type { PRRendererOptions, PRData, PRMetadata, ConflictFile, SideLineMap } from "./pr-renderer.js";
import {
  addRepo, addWorktree, remove as removeConfig, list as listConfig,
  resolve as resolveAlias, detectRepoRoot, getRepos,
} from "./config.js";

// ─── Repo .env loading ───────────────────────────────────────────────────────

/**
 * Load credentials (and any other vars) from the repository's `.env` file.
 *
 * Reads `<dir>/.env` and the git repository root's `.env`, parsing simple
 * `KEY=value` / `export KEY=value` lines. Only fills variables that are NOT
 * already set in the real environment, so an explicit GITHUB_TOKEN or a
 * CI-provided token always wins. This NEVER writes to or modifies the file.
 */
function loadRepoEnv(startDir: string): void {
  const candidates: string[] = [];
  const add = (p: string) => { if (p && !candidates.includes(p)) candidates.push(p); };
  try { add(join(startDir, ".env")); } catch { /* ignore */ }
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd: startDir, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (top) add(join(top, ".env"));
  } catch { /* not a git repo — fine */ }

  for (const file of candidates) {
    let text: string;
    try {
      if (!existsSync(file)) continue;
      text = readFileSync(file, "utf-8");
    } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  prNumber: number;
  token: string;
  dir: string;
  repo: string | null;
  worktree: string | null;
  reviewOnly: boolean;
  reportOnly: boolean;
  resolutions: Map<string, "baseline" | "incoming">;
  bareBaseline: boolean;  // --use-baseline with no filename
  bareIncoming: boolean;  // --use-incoming with no filename
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let prNumber: number | null = null;
  let token: string | null = null;
  let dir: string = process.cwd();
  let repo: string | null = null;
  let worktree: string | null = null;
  let reviewOnly = false;
  let reportOnly = false;
  const resolutions = new Map<string, "baseline" | "incoming">();
  let bareBaseline = false;
  let bareIncoming = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--token" && i + 1 < args.length) {
      token = args[++i];

    } else if (arg === "--dir" && i + 1 < args.length) {
      dir = args[++i];

    } else if (arg === "--repo" && i + 1 < args.length) {
      repo = args[++i];

    } else if (arg === "--worktree" && i + 1 < args.length) {
      worktree = args[++i];

    } else if (arg === "--review-only") {
      reviewOnly = true;

    } else if (arg === "--report-only") {
      reportOnly = true;

    } else if (arg === "--use-baseline") {
      // Check if next arg is a filename (not another flag or missing)
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        resolutions.set(args[++i], "baseline");
      } else {
        bareBaseline = true;
      }

    } else if (arg === "--use-incoming") {
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        resolutions.set(args[++i], "incoming");
      } else {
        bareIncoming = true;
      }

    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);

    } else if (!arg.startsWith("-") && prNumber === null) {
      prNumber = parseInt(arg, 10);
      if (isNaN(prNumber)) {
        console.error(`Error: Invalid PR number: ${arg}`);
        process.exit(1);
      }
    }
  }

  if (prNumber === null) {
    console.error("Error: PR number is required.");
    printUsage();
    process.exit(1);
  }

  // Resolve --repo / --worktree into a directory path
  if (repo) {
    try {
      dir = resolveAlias(repo, worktree ?? undefined);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  }

  // Load the repo's .env (fills missing env vars only; never overwrites real env)
  loadRepoEnv(dir);

  // Resolve token: --token > $GITHUB_TOKEN > $GH_TOKEN > $GITHUB_PAT > repo .env
  if (!token) {
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || null;
  }
  if (!token) {
    console.error("Error: No GitHub token found. Provide --token or set GITHUB_TOKEN, GH_TOKEN, or GITHUB_PAT.");
    process.exit(1);
  }

  return { prNumber, token, dir, repo, worktree, reviewOnly, reportOnly, resolutions, bareBaseline, bareIncoming };
}

function printUsage(): void {
  console.log(`
git-print — GitHub PR review printer & conflict reporter

USAGE
  git-print <pr-number> [options]       Generate PR review + report files
  git-print <command> [args]            Run a subcommand

PR GENERATION
  git-print 24                          Print PR #24 from the current repo
  git-print 24 --repo zenith-mcp        Print from a registered repo alias
  git-print 24 --repo zenith-mcp --worktree pr23-test
                                        Print from a specific worktree
  git-print 24 --review-only            Only generate the conversation review
  git-print 24 --report-only            Only generate the CI/commits/files report

OPTIONS
  --token <token>       GitHub personal access token
                        (default: \$GITHUB_TOKEN, \$GH_TOKEN, \$GITHUB_PAT,
                         or one of those keys in <repo>/.env)
  --dir <path>          Directory to detect git repo from (default: cwd)
  --repo <alias>        Use a registered repo alias instead of --dir
  --worktree <name>     Use a named worktree within --repo
  --review-only         Only write the PR conversation review file
  --report-only         Only write the CI / commits / files report
  --use-baseline <file> Resolve conflict in <file> using the base branch version
  --use-incoming <file> Resolve conflict in <file> using the PR branch version
  -h, --help            Show this help

CONFLICT RESOLUTION
  git-print 24 --use-incoming src/foo.ts
                        Accept the incoming (PR) version of foo.ts
  git-print 24 --use-baseline src/foo.ts
                        Accept the baseline (base branch) version of foo.ts
  git-print 24 --use-incoming          (auto-selects the single conflicting file)

  Runs a sandbox trial merge to validate the resolution before applying
  it to your working tree. Must be on the PR head branch.

REPO ALIASES  (config: ~/.config/git-print/config)
  git-print add <alias> [path]          Register a repo alias
                                        Omit path to auto-detect from cwd
  git-print add <alias>/<name> [path]   Register a named worktree
                                        Omit path to use cwd
  git-print list                        List all registered repos + worktrees
                                        (auto-discovered worktrees shown too)
  git-print remove <alias>              Remove a repo and all its worktrees
  git-print remove <alias>/<name>       Remove a single worktree entry

SETUP & AUTOMATION  (idempotent — safe to re-run any number of times)
  git-print install     Install, all in one command:
                          • git-print launcher on your PATH, independent of node
                            version (~/.local/bin, or \$GIT_PRINT_BIN_DIR)
                          • pre-push conflict hook
                          • CI-failure reporter workflow in registered repos
                        --cli-only  launcher only     --ci-only  workflow only
                        --dry-run   preview, write nothing
  git-print uninstall   Remove all of the above (--cli-only = just the launcher)
  git-print auto        Run manually: detect local conflicts, find the open
                        PR for the current branch, generate/overwrite files
                        Exits silently if no conflicts found

OUTPUT FILES  (.git/Git-Print/ in the repo root)
  PR-<n>-review.md      Full PR conversation — comments, reviews, bots
  PR-<n>-report.md      CI checks, commits, files changed summary
  PR-<n>-conflicts.md   Merge conflicts as line-numbered diffs — real editor
                        line numbers, ours/theirs/ancestor, labeled markers

EXAMPLES
  git-print add zenith-mcp /home/user/Projects/Zenith-MCP
  git-print add zenith-mcp/pr23-test /home/user/Worktrees/pr23-test
  git-print 24 --repo zenith-mcp
  git-print 24 --repo zenith-mcp --worktree pr23-test
  git-print install && git push origin my-branch
`.trim());
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

function getGitRoot(fromDir: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: fromDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error(`Error: Not a git repository (or any parent up to mount point): ${fromDir}`);
    process.exit(1);
  }
}

function getOutputDir(gitRoot: string): string {
  const gitDir = execSync("git rev-parse --path-format=absolute --git-dir", {
    cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  const commonDir = gitCommonDir(gitRoot);
  return gitDir !== commonDir
    ? join(gitRoot, ".git-print")   // worktree
    : join(commonDir, "Git-Print"); // main repo
}

function getCurrentBranch(fromDir: string): string | null {
  try {
    return execSync("git branch --show-current", {
      cwd: fromDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function getGitVersion(): { major: number; minor: number } {
  try {
    const raw = execSync("git --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    // "git version 2.54.1" → [2, 54]
    const m = raw.match(/(\d+)\.(\d+)/);
    if (!m) return { major: 0, minor: 0 };
    return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
  } catch {
    return { major: 0, minor: 0 };
  }
}

/**
 * Find the open PR number for the current branch using the same
 * fetchAllPages pattern used throughout git-print.
 */
async function findPRForBranch(
  owner: string, repo: string, branch: string, token: string,
): Promise<number | null> {
  try {
    const prs = await fetchAllPages<{ number: number }>(
      `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open&per_page=1`,
      token,
    );
    return prs.length > 0 ? prs[0].number : null;
  } catch {
    return null;
  }
}

/**
 * Redact userinfo (user:pass@) from a URL so credentials don't leak in error messages.
 * Works on URLs that may or may not parse via URL().
 */
function redactUrl(url: string): string {
  // https://user:token@host/path → https://***@host/path
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, "$1***@");
}

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
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  // Normalize SCP-style "git@github.com:owner/repo" → "ssh://git@github.com/owner/repo"
  let normalized = url.trim();
  const scp = normalized.match(/^(?:[^@\s:/]+@)?([^\s:/]+):([^\s].*)$/);
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized);
  if (!isUrl && scp) {
    normalized = `ssh://${normalized.replace(":", "/")}`;
  }

  let host: string;
  let path: string;
  try {
    const u = new URL(normalized);
    host = u.hostname;
    path = u.pathname;
  } catch {
    // Last-ditch: pull out everything after a github.com[:/] separator
    const m = normalized.match(/github\.com[:/](.+)$/i);
    if (!m) return null;
    host = "github.com";
    path = "/" + m[1];
  }

  if (!/github\.com$/i.test(host)) return null;

  // Strip leading slash, then strip exactly one trailing ".git"
  let pathStr = path.replace(/^\/+/, "");
  if (pathStr.endsWith(".git")) pathStr = pathStr.slice(0, -4);

  const parts = pathStr.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  // Repo name is everything after owner (collapsed) — GitHub repos are owner/repo
  // but allow paths like owner/repo/anything (we ignore the tail).
  const repo = parts[1];
  if (!owner || !repo) return null;

  return { owner, repo };
}

function getGitHubRemote(gitRoot: string): { owner: string; repo: string } {
  let remoteUrl: string;
  try {
    remoteUrl = execSync("git remote get-url origin", {
      cwd: gitRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error("Error: No 'origin' remote found. Set a GitHub remote as 'origin'.");
    process.exit(1);
  }

  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed) {
    console.error(`Error: Cannot parse GitHub owner/repo from remote URL: ${redactUrl(remoteUrl)}`);
    process.exit(1);
  }
  return parsed;
}

/**
 * Non-exiting variant of getGitHubRemote: returns null instead of calling
 * process.exit when there's no `origin` remote or it isn't a GitHub URL.
 * Used by `git-print auto`, which must degrade gracefully to a no-PR conflict
 * report when run in an offline / non-GitHub repo.
 */
function tryGetGitHubRemote(gitRoot: string): { owner: string; repo: string } | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return parseGitHubRemote(remoteUrl);
  } catch {
    return null;
  }
}

// ─── Subcommand handler ─────────────────────────────────────────────────────

/**
 * Handle config subcommands (add / list / remove) and exit.
 * Called before parseArgs() so these commands never need a PR number or token.
 */
function runSubcommand(args: string[]): void {
  const [sub, ...rest] = args;

  if (sub === "list") {
    listConfig();
    process.exit(0);
  }

  if (sub === "remove") {
    const target = rest[0];
    if (!target) {
      console.error("Usage: git-print remove <alias> | <alias>/<worktree>");
      process.exit(1);
    }
    try {
      removeConfig(target);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (sub === "add") {
    // Formats:
    //   add <alias> [path]          → register repo
    //   add <alias>/<name> [path]   → register worktree
    const target = rest[0];
    const explicitPath = rest[1];  // may be undefined → auto-detect

    if (!target) {
      console.error("Usage: git-print add <alias> [path]");
      console.error("       git-print add <alias>/<worktree> [path]");
      process.exit(1);
    }

    const slashIdx = target.indexOf("/");
    try {
      if (slashIdx !== -1) {
        const alias = target.slice(0, slashIdx);
        const wtName = target.slice(slashIdx + 1);
        if (!wtName) {
          console.error(`Error: Missing worktree name after '/'. Example: add ${alias}/my-branch`);
          process.exit(1);
        }
        addWorktree(alias, wtName, explicitPath);
      } else {
        addRepo(target, explicitPath);
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
}

// ─── Local conflict detection ─────────────────────────────────────────────────

/**
 * Check whether the given directory has unresolved merge conflict markers
 * in the working tree. Uses `git diff --name-only --diff-filter=U`.
 * Returns the list of conflicting file paths, or an empty array if none.
 */
function detectLocalConflicts(dir: string): string[] {
  try {
    const out = execSync("git diff --name-only --diff-filter=U", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out ? out.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Parse merge-conflict regions from a working-tree file's content. Handles
 * both 2-way markers (`<<<<<<<` / `=======` / `>>>>>>>`) and 3-way diff3 /
 * zdiff3 markers that carry a `|||||||` common-ancestor section. Returns one
 * entry per conflict with the 0-based line index of every marker plus the
 * branch labels git wrote into the `<<<<<<<` and `>>>>>>>` lines.
 */
interface ConflictRegion {
  start: number;        // index of  <<<<<<<
  ancStart: number;     // index of  |||||||   (-1 when 2-way)
  sep: number;          // index of  =======
  end: number;          // index of  >>>>>>>
  oursLabel: string;    // text after <<<<<<<
  theirsLabel: string;  // text after >>>>>>>
}

function parseConflictRegions(content: string): ConflictRegion[] {
  const lines = content.split("\n");
  const regions: ConflictRegion[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<< ")) { i++; continue; }
    const start = i;
    let ancStart = -1, sep = -1, end = -1, j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.startsWith("||||||| ") && ancStart === -1 && sep === -1) ancStart = j;
      else if (l === "=======" && sep === -1) sep = j;
      else if (l.startsWith(">>>>>>> ")) { end = j; break; }
      j++;
    }
    if (sep === -1 || end === -1) { i = start + 1; continue; }  // malformed — skip
    regions.push({
      start, ancStart, sep, end,
      oursLabel: lines[start].slice(8).trim(),
      theirsLabel: lines[end].slice(8).trim(),
    });
    i = end + 1;
  }
  return regions;
}

// ─── Unified conflict model (shared by local + trial-merge paths) ─────────────

interface URegion {
  startLine: number;              // 1-based line of <<<<<<<
  endLine: number;                // 1-based line of >>>>>>>
  oursLines: string[];
  ancestorLines: string[] | null; // null => 2-way (no |||||||)
  theirsLines: string[];
  oursLabel: string;
  theirsLabel: string;
  ctxBefore: string[];
  ctxAfter: string[];
}

interface UFile {
  path: string;
  notice: "oversized" | "nomarkers" | null;
  regions: URegion[];
  /** result-line → {ours, theirs, base} per-side line numbers. Context from
   *  git's combined diff; conflict-block + BASE numbers located structurally in
   *  the clean blobs. Absent → renderer falls back to merged-file numbers. */
  sideMap?: SideLineMap;
}

const CONFLICT_CONTEXT = 3;
// Extra context requested from `git diff` when building the per-side line map,
// so every displayed context line (≤ CONFLICT_CONTEXT) is covered by a hunk.
const SIDEMAP_CONTEXT = 8;

/** Human label for a conflict region's location, in real per-side line numbers
 *  (read from the combined-diff side map): the ours span for an edit/delete, or
 *  the theirs span for an incoming-only add. Falls back to the merged-file span
 *  when no side map is available. */
function regionRangeLabel(file: UFile, rg: URegion): string {
  const sm = file.sideMap;
  if (sm) {
    const ours: number[] = [], theirs: number[] = [];
    for (let n = rg.startLine; n <= rg.endLine; n++) {
      const e = sm.get(n);
      if (e?.ours != null) ours.push(e.ours);
      if (e?.theirs != null) theirs.push(e.theirs);
    }
    if (ours.length) return `ours L${Math.min(...ours)}–${Math.max(...ours)}`;
    if (theirs.length) return `theirs L${Math.min(...theirs)}–${Math.max(...theirs)}`;
  }
  return `lines ${rg.startLine}–${rg.endLine}`;
}

/** Build the per-side line map for one conflicted working-tree file. Local-only:
 *  context ours/theirs come from git's combined diff (`git diff`), while each
 *  conflict block (incl. BASE) is located structurally in its exact index-stage
 *  blob — stage 1 = base, 2 = ours, 3 = theirs. Best-effort (undefined on
 *  failure → renderer falls back to merged-file numbers). */
function workingTreeSideMap(dir: string, relPath: string, content: string):
  SideLineMap | undefined {
  try {
    let combined: Map<number, { ours: number | null; theirs: number | null }> | undefined;
    try {
      const cc = execFileSync(
        "git", ["diff", `-U${SIDEMAP_CONTEXT}`, "--", relPath],
        { cwd: dir, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"] },
      ).toString();
      const m = parseCombinedDiffSideMap(cc);
      combined = m.size > 0 ? m : undefined;
    } catch { combined = undefined; }
    const blobs = {
      ours:   readBlobLines(dir, `:2:${relPath}`),
      base:   readBlobLines(dir, `:1:${relPath}`),
      theirs: readBlobLines(dir, `:3:${relPath}`),
    };
    const map = buildSideLineMap(content, combined, blobs);
    return map.size > 0 ? map : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalizer A — build the unified model from the live working tree. Reads
 * each conflicted file and parses its real markers, so gutter line numbers
 * are the exact editor lines.
 */
function conflictFilesFromWorkingTree(dir: string, conflictPaths: string[]): UFile[] {
  const files: UFile[] = [];
  for (const relPath of conflictPaths) {
    const fullPath = join(dir, relPath);
    try {
      const stat = statSync(fullPath);
      if (stat.size > 512_000) { files.push({ path: relPath, notice: "oversized", regions: [] }); continue; }
      const content = readFileSync(fullPath, "utf-8");
      if (content.includes("\u0000")) { files.push({ path: relPath, notice: "nomarkers", regions: [] }); continue; }
      const lines = content.split("\n");
      const raw = parseConflictRegions(content);
      if (raw.length === 0) { files.push({ path: relPath, notice: "nomarkers", regions: [] }); continue; }
      const regions: URegion[] = raw.map((rg, idx) => {
        const oursBoundary = rg.ancStart !== -1 ? rg.ancStart : rg.sep;
        // Clamp context so neighboring regions never bleed markers into each other.
        const prevEnd = idx > 0 ? raw[idx - 1].end : -1;
        const nextStart = idx < raw.length - 1 ? raw[idx + 1].start : lines.length;
        const ctxStart = Math.max(0, rg.start - CONFLICT_CONTEXT, prevEnd + 1);
        const ctxEnd = Math.min(lines.length, rg.end + 1 + CONFLICT_CONTEXT, nextStart);
        return {
          startLine: rg.start + 1,
          endLine: rg.end + 1,
          oursLines: lines.slice(rg.start + 1, oursBoundary),
          ancestorLines: rg.ancStart !== -1 ? lines.slice(rg.ancStart + 1, rg.sep) : null,
          theirsLines: lines.slice(rg.sep + 1, rg.end),
          oursLabel: rg.oursLabel,
          theirsLabel: rg.theirsLabel,
          ctxBefore: lines.slice(ctxStart, rg.start),
          ctxAfter: lines.slice(rg.end + 1, ctxEnd),
        };
      });
      files.push({ path: relPath, notice: null, regions, sideMap: workingTreeSideMap(dir, relPath, content) });
    } catch {
      files.push({ path: relPath, notice: "nomarkers", regions: [] });
    }
  }
  return files;
}

/**
 * Normalizer B — build the unified model from a trial-merge ConflictFile[]
 * (as produced by extractConflicts via `git merge-tree`). The region line
 * numbers are the merged-file lines, identical to what the working tree would
 * show after the merge.
 */
function conflictFilesFromExtract(
  conflicts: ConflictFile[], oursLabel: string, theirsLabel: string,
): UFile[] {
  const splitOrEmpty = (s?: string): string[] =>
    (s === undefined || s === "") ? [] : s.split("\n");
  return conflicts.map((cf): UFile => {
    if (cf.oversized) return { path: cf.path, notice: "oversized", regions: [] };
    if (cf.regions.length === 0) return { path: cf.path, notice: "nomarkers", regions: [] };
    const regions: URegion[] = cf.regions.map((r): URegion => ({
      startLine: r.startLine,
      endLine: r.endLine,
      oursLines: splitOrEmpty(r.baseContent),
      ancestorLines: r.ancestorContent === undefined ? null : splitOrEmpty(r.ancestorContent),
      theirsLines: splitOrEmpty(r.incomingContent),
      oursLabel,
      theirsLabel,
      ctxBefore: r.contextBefore.slice(-CONFLICT_CONTEXT),
      ctxAfter: r.contextAfter.slice(0, CONFLICT_CONTEXT),
    }));
    return { path: cf.path, notice: null, regions, sideMap: cf.sideMap };
  });
}

/**
 * Shared markdown engine. Both conflict paths funnel through here, so the
 * output is byte-for-byte consistent regardless of how the conflicts were
 * found. Each conflict becomes a single line-numbered ```diff fence using the
 * real file line numbers, with ours = `-`, theirs = `+`, the common ancestor
 * shown as context, and every git marker turned into a labeled full-width rule.
 */
function composeConflictMarkdown(
  files: UFile[],
  opts: {
    prNumber: number;
    oursName: string;
    theirsName: string;
    currentBranch: string | null;
    showQuickResolve: boolean;
  },
): string {
  const RULE_WIDTH = 66;
  const { prNumber, oursName, theirsName, currentBranch, showQuickResolve } = opts;
  const totalRegions = files.reduce((s, f) => s + f.regions.length, 0);

  const out: string[] = [];
  const w = (line = "") => out.push(line);
  const rule = (prefix: string, ch: string): string => {
    const pad = Math.max(3, RULE_WIDTH - prefix.length);
    return `${prefix} ${ch.repeat(pad)}`;
  };

  // ── Header ──
  w(`# ⚠ Merge Conflicts${prNumber > 0 ? ` — PR #${prNumber}` : ""}`);
  w();
  w(`\`${theirsName}\` does not merge cleanly into \`${oursName}\``);
  w();
  w(`**${files.length}** conflicting file${files.length !== 1 ? "s" : ""} · **${totalRegions}** conflict region${totalRegions !== 1 ? "s" : ""}`);
  w();
  w(`**OURS** = your branch (\`${oursName}\`)`);
  w(`**THEIRS** = incoming (\`${theirsName}\`)`);
  w(`**BASE** = common ancestor _(shown only with diff3 / zdiff3 conflict style)_`);
  w();
  w(`Gutter shows per-side real file line numbers — ours on \`-\`/context, theirs on \`+\`, base on the ancestor block; conflict markers are unnumbered.`);
  w();
  w("---");

  for (const file of files) {
    w();
    const badge = file.notice === "oversized" ? "⚠ oversized"
      : file.notice === "nomarkers" ? "no inline markers"
      : `${file.regions.length} conflict${file.regions.length !== 1 ? "s" : ""}`;
    w(`## 📁 \`${file.path}\`  ·  ${badge}`);
    w();

    if (file.notice === "oversized") { w("> File exceeds 500 KB — content not shown."); continue; }
    if (file.notice === "nomarkers") { w("> No inline conflict markers — binary, delete/modify, or rename conflict."); continue; }

    for (let r = 0; r < file.regions.length; r++) {
      const rg = file.regions[r];
      const oursCount = rg.oursLines.length;
      const theirsCount = rg.theirsLines.length;

      let cls: string;
      if (oursCount === 0)        cls = `🟢 Incoming adds ${theirsCount} line${theirsCount !== 1 ? "s" : ""}; ours is empty here.`;
      else if (theirsCount === 0) cls = `🔴 Incoming deletes ${oursCount} line${oursCount !== 1 ? "s" : ""} that ours keeps.`;
      else                        cls = `⚡ Both sides edited this span${rg.ancestorLines !== null ? " (ancestor shown)" : ""}.`;

      w(`### Conflict ${r + 1} of ${file.regions.length} · ${regionRangeLabel(file, rg)}`);
      w();
      w(`> ${cls}`);
      w();

      const sideMap = file.sideMap;
      const oursAt = (n: number): number | null => sideMap ? (sideMap.get(n)?.ours ?? null) : n;
      const theirsAt = (n: number): number | null => sideMap ? (sideMap.get(n)?.theirs ?? null) : n;
      const baseAt = (n: number): number | null => sideMap ? (sideMap.get(n)?.base ?? null) : null;
      const oursLabel = (rg.oursLabel === "HEAD" || rg.oursLabel === "") ? (currentBranch ?? oursName) : rg.oursLabel;
      const theirsLabel = rg.theirsLabel === "" ? theirsName : rg.theirsLabel;

      // Per-side gutter: ours numbers on ours + context lines, theirs numbers on
      // theirs lines, blank on every git marker and the BASE/ancestor block.
      // `ln` walks the real result-file line, so it keys straight into sideMap.
      const gutterRows: { num: number | null; text: string }[] = [];
      let ln = rg.startLine - rg.ctxBefore.length;
      for (const t of rg.ctxBefore) { gutterRows.push({ num: oursAt(ln), text: `   ${t}` }); ln++; }
      gutterRows.push({ num: null, text: `  ${rule(`<<<<<<< OURS · ${oursLabel}`, "═")}` }); ln++;
      for (const t of rg.oursLines) { gutterRows.push({ num: oursAt(ln), text: ` - ${t}` }); ln++; }
      if (rg.ancestorLines !== null) {
        gutterRows.push({ num: null, text: `  ${rule("||||||| BASE · common ancestor", "─")}` }); ln++;
        for (const t of rg.ancestorLines) { gutterRows.push({ num: baseAt(ln), text: `   ${t}` }); ln++; }
      }
      gutterRows.push({ num: null, text: `  ${rule(`======= THEIRS · ${theirsLabel}`, "═")}` }); ln++;
      for (const t of rg.theirsLines) { gutterRows.push({ num: theirsAt(ln), text: ` + ${t}` }); ln++; }
      gutterRows.push({ num: null, text: `  ${rule(">>>>>>> END", "═")}` }); ln++;
      for (const t of rg.ctxAfter) { gutterRows.push({ num: oursAt(ln), text: `   ${t}` }); ln++; }

      const width = Math.max(1, ...gutterRows.map(r => r.num != null ? String(r.num).length : 0));
      const g = (n: number | null) => (n != null ? String(n) : "").padStart(width);
      w("```diff");
      for (const row of gutterRows) out.push(`${g(row.num)}${row.text}`.replace(/\s+$/, ""));
      w("```");
      w();
    }
  }

  // ── Summary ──
  w("---");
  w();
  w("## Summary");
  w();
  w("| File | Conflicts | Lines |");
  w("|------|-----------|-------|");
  for (const file of files) {
    if (file.notice === "oversized")      w(`| \`${file.path}\` | ⚠ oversized | — |`);
    else if (file.notice === "nomarkers") w(`| \`${file.path}\` | delete/modify | — |`);
    else {
      const spans = file.regions.map(rr => regionRangeLabel(file, rr)).join(", ");
      w(`| \`${file.path}\` | ${file.regions.length} | ${spans} |`);
    }
  }
  w();
  w(`**Total:** ${files.length} file${files.length !== 1 ? "s" : ""} · ${totalRegions} conflict region${totalRegions !== 1 ? "s" : ""}`);

  if (showQuickResolve && prNumber > 0) {
    const fileArgs = files
      .filter(f => f.notice !== "oversized")
      .map(f => `--use-incoming ${f.path}`)
      .join(" ");
    w();
    w("### Quick Resolve");
    w();
    w("Accept the incoming side for every file (swap to `--use-baseline` per file as needed):");
    w();
    w("```bash");
    w(`git-print ${prNumber} ${fileArgs}`);
    w("```");
  }
  w();

  return out.join("\n");
}

/**
 * Local working-tree conflict report — fires whenever `git diff` shows
 * unmerged files, regardless of GitHub's pr.mergeable value.
 */
async function renderLocalConflicts(
  dir: string,
  conflictPaths: string[],
  outputPath: string,
  prNumber: number,
  context: { baseBranch: string; headBranch: string },
): Promise<string> {
  const currentBranch = getCurrentBranch(dir);
  const files = conflictFilesFromWorkingTree(dir, conflictPaths);
  const firstRegion = files.find(f => f.regions.length > 0)?.regions[0];
  const oursName = currentBranch ?? context.baseBranch;
  const theirsName = (context.headBranch && context.headBranch !== "HEAD")
    ? context.headBranch
    : (firstRegion?.theirsLabel ?? context.headBranch);
  const md = composeConflictMarkdown(files, {
    prNumber, oursName, theirsName, currentBranch, showQuickResolve: false,
  });
  await writeFile(outputPath, md, "utf-8");
  return outputPath;
}

/**
 * Trial-merge conflict report — used when the working tree is clean but GitHub
 * reports the PR as dirty. Runs the in-memory `git merge-tree` trial merge via
 * extractConflicts(), then renders through the same engine as the local path.
 * Mirrors the old renderConflicts() contract: returns the path, or null when
 * there's nothing to report (and clears any stale file). The PR review
 * pipeline is untouched.
 */
async function renderTrialMergeConflicts(
  data: PRData,
  opts: { gitRoot: string; outputPath: string; pullNumber: number },
): Promise<string | null> {
  const { gitRoot, outputPath, pullNumber } = opts;
  const { pr } = data;

  if (!(pr.mergeable === false && pr.mergeable_state === "dirty")) {
    try { await unlink(outputPath); } catch { /* didn't exist */ }
    return null;
  }

  const baseBranch = pr.base.ref;
  const headBranch = pr.head.ref;
  console.error(`Merge conflicts detected — running in-memory trial merge...`);

  let conflicts: ConflictFile[];
  try {
    conflicts = extractConflicts(gitRoot, baseBranch, headBranch, { pullNumber });
  } catch (e: any) {
    const minimal = `# ⚠ Merge Conflicts — PR #${pullNumber}\n\n\`${headBranch}\` does not merge cleanly into \`${baseBranch}\`\n\nCould not perform a local trial merge to extract conflict details.\nError: ${e.message}\n`;
    await writeFile(outputPath, minimal, "utf-8");
    return outputPath;
  }

  if (conflicts.length === 0) {
    console.error(`Trial merge found no conflicts (API may be stale).`);
    try { await unlink(outputPath); } catch { /* fine */ }
    return null;
  }

  const files = conflictFilesFromExtract(conflicts, baseBranch, headBranch);
  const md = composeConflictMarkdown(files, {
    prNumber: pullNumber,
    oursName: baseBranch,
    theirsName: headBranch,
    currentBranch: null,
    showQuickResolve: true,
  });
  await writeFile(outputPath, md, "utf-8");
  console.error(`Written conflict report to ${outputPath} (${md.length} bytes)`);
  return outputPath;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const {
    prNumber, token, dir, repo: _repo, worktree: _worktree,
    reviewOnly, reportOnly, resolutions, bareBaseline, bareIncoming,
  } = parseArgs();

  const isResolveMode = resolutions.size > 0 || bareBaseline || bareIncoming;

  // Git detection
  const gitRoot = getGitRoot(dir);
  const { owner, repo } = getGitHubRemote(gitRoot);
  console.error(`Detected repo: ${owner}/${repo} (${gitRoot})`);

  // Resolve the administrative Git directory. In a linked worktree, <root>/.git
  // is a file, not a directory; using --git-common-dir gives us the shared
  // store where reports and temp worktrees belong.
  const outputDir = getOutputDir(gitRoot);

  const reviewPath = join(outputDir, `PR-${prNumber}-review.md`);
  const reportPath = join(outputDir, `PR-${prNumber}-report.md`);
  const conflictPath = join(outputDir, `PR-${prNumber}-conflicts.md`);

  const generatedPaths: string[] = [];

  // mkdir is deferred until we actually need to write — dry runs in particular
  // must not create or touch report directories.
  let outputDirReady = false;
  const ensureOutputDir = async (): Promise<void> => {
    if (outputDirReady) return;
    await mkdir(outputDir, { recursive: true });
    outputDirReady = true;
  };

  // Determine if we need the full API fetch or just PR metadata.
  // Resolve mode only needs branch names unless review/report files are also requested.
  const needsFullFetch = !isResolveMode || reviewOnly || reportOnly;

  let data: PRData | null = null;
  let pr: PRMetadata;

  if (needsFullFetch) {
    data = await fetchAllPRData(owner, repo, prNumber, token, token);
    pr = data.pr;
  } else {
    // Lightweight: single API call for branch names + merge status
    pr = await fetchPRMetadata(owner, repo, prNumber, token);
  }

  const baseOptions: PRRendererOptions = {
    owner, repo,
    pullNumber: prNumber,
    token,
    outputPath: "",
    graphqlToken: token,
    includeResolvedThreads: true,
    fetchCheckAnnotations: true,
    gitRoot,
  };

  if (isResolveMode) {
    // ──── RESOLVE MODE ────
    const baseBranch = pr.base.ref;
    const headBranch = pr.head.ref;

    // Handle bare flags (no filename) — auto-resolve for single-conflict PRs
    if ((bareBaseline || bareIncoming) && resolutions.size === 0) {
      // Contradictory: both bare flags with no filenames
      if (bareBaseline && bareIncoming) {
        console.error(`✗ Both --use-baseline and --use-incoming specified without filenames — contradictory.`);
        console.error(`  Specify a filename with each flag, e.g.:`);
        console.error(`  git-print ${prNumber} --use-baseline file1 --use-incoming file2`);
        process.exit(1);
      }

      // Need to figure out which files conflict
      console.error(`Detecting conflict files for bare flag resolution...`);
      const conflicts = extractConflicts(gitRoot, baseBranch, headBranch, { pullNumber: prNumber });
      const conflictPaths = conflicts.map(c => c.path);

      if (conflictPaths.length === 0) {
        console.error(`No conflicts found — PR merges cleanly.`);
        process.exit(0);
      }

      if (conflictPaths.length === 1) {
        // Single file — auto-apply the bare flag
        const side = bareIncoming ? "incoming" as const : "baseline" as const;
        resolutions.set(conflictPaths[0], side);
        console.error(`Single conflicting file: ${conflictPaths[0]} → will use ${side}`);
      } else {
        // Multiple files — can't auto-resolve
        console.error(`\n✗ Multiple conflicting files — specify which file for each flag:`);
        for (const f of conflictPaths) {
          console.error(`  ${f}`);
        }
        console.error(`\nExample: git-print ${prNumber} --use-baseline ${conflictPaths[0]} --use-incoming ${conflictPaths[1]}`);
        process.exit(1);
      }
    }

    // Single resolution flow — validates in a sandbox worktree then applies
    // to the user's current working tree (which must be on the PR head branch).
    const result = resolveConflicts({
      gitRoot, owner, repo,
      pullNumber: prNumber, token,
      base: baseBranch,
      head: headBranch,
      resolutions,
    });

    if (result.status === "aborted") {
      process.exit(1);
    }

    // In resolve mode, only generate review/report if explicitly requested
    if (reviewOnly && data) {
      await ensureOutputDir();
      await renderPR(data, { ...baseOptions, outputPath: reviewPath });
      generatedPaths.push(reviewPath);
    }
    if (reportOnly && data) {
      await ensureOutputDir();
      await renderReport(data, { ...baseOptions, outputPath: reportPath });
      generatedPaths.push(reportPath);
    }

    // A LOCAL commit alone doesn't update the PR on GitHub, so we leave the
    // conflict report in place. Report mode will remove it the next time
    // GitHub confirms the PR is mergeable.

  } else {
    // ──── REPORT MODE (default) ────
    await ensureOutputDir();

    if (!reportOnly) {
      await renderPR(data!, { ...baseOptions, outputPath: reviewPath });
      generatedPaths.push(reviewPath);
    }

    if (!reviewOnly) {
      await renderReport(data!, { ...baseOptions, outputPath: reportPath });
      generatedPaths.push(reportPath);
    }

    // Auto-detect conflicts — LOCAL state first, GitHub API as fallback
    // This is the key design: git-print works from whatever worktree you're in,
    // regardless of GitHub's pr.mergeable field.
    const localConflicts = detectLocalConflicts(dir);

    if (localConflicts.length > 0) {
      // Local working-tree has unresolved conflict markers — render directly
      // without a trial merge. This fires from any conflicted worktree.
      console.error(`\n⚠ Local merge conflicts detected in ${dir}`);
      for (const f of localConflicts) console.error(`  • ${f}`);

      const baseBranch = pr.base?.ref ?? "base";
      const headBranch = pr.head?.ref ?? "head";

      await ensureOutputDir();
      const cPath = await renderLocalConflicts(
        dir, localConflicts, conflictPath, prNumber,
        { baseBranch, headBranch },
      );
      generatedPaths.push(cPath);
      console.error(`Written conflict report to PR-${prNumber}-conflicts.md`);

    } else if (pr.mergeable === false && pr.mergeable_state === "dirty") {
      // No local conflicts but GitHub says the PR is dirty — in-memory trial merge
      const cPath = await renderTrialMergeConflicts(data!, {
        gitRoot,
        outputPath: conflictPath,
        pullNumber: prNumber,
      });

      if (cPath) {
        generatedPaths.push(cPath);
        console.error(`\n⚠ Merge conflicts detected — see PR-${prNumber}-conflicts.md`);
      }
    } else if (pr.mergeable === null) {
      console.error(`⚠ GitHub hasn't computed merge status yet. Skipping conflict report.`);
    } else {
      // No conflicts anywhere — clean up stale conflict file if it exists
      if (existsSync(conflictPath)) {
        try { await unlink(conflictPath); } catch { /* fine */ }
        console.error(`Removed stale conflict file: PR-${prNumber}-conflicts.md`);
      }
    }
  }

  // Print generated file paths to stdout
  for (const p of generatedPaths) {
    console.log(p);
  }
}

// Only run main() when executed as a script — not when imported (e.g. by tests
// that exercise parseGitHubRemote). Resolve the real path in case the binary is
// invoked via a symlink (npm link / pnpm link).
const isEntry = (() => {
  try {
    const { resolve } = require("node:path");
    const argv1 = process.argv[1] ?? "";
    const basename = require("node:path").basename(argv1);
    if (basename === "git-print" || basename === "git-print.cmd") return true;
    const real = resolve(argv1);
    return real.endsWith("cli.js") || real.endsWith("cli.ts") || basename === "cli.js" || basename === "cli.ts";
  } catch { return true; }
})();

// Entry dispatch lives at the END of this file (after all declarations) so that
// install/uninstall/etc. don't hit a temporal-dead-zone on module-level consts.

// ─── Auto subcommand ──────────────────────────────────────────────────────────

async function runAuto(): Promise<void> {
  const dir = process.cwd();
  const conflictFiles = detectLocalConflicts(dir);
  if (conflictFiles.length === 0) process.exit(0);

  console.error(`\n⚠  git-print: ${conflictFiles.length} unresolved conflict${conflictFiles.length !== 1 ? "s" : ""} detected`);
  for (const f of conflictFiles) console.error(`   • ${f}`);

  const gitRoot = getGitRoot(dir);
  const branch  = getCurrentBranch(gitRoot);
  loadRepoEnv(gitRoot);  // pick up GITHUB_TOKEN/PAT from the repo's .env if present
  const token   = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || null;

  let remote: { owner: string; repo: string } | null = null;
  remote = tryGetGitHubRemote(gitRoot);

  const outputDir = getOutputDir(gitRoot);
  await mkdir(outputDir, { recursive: true });

  let prNumber: number | null = null;
  if (remote && branch && token) {
    prNumber = await findPRForBranch(remote.owner, remote.repo, branch, token);
  }

  if (prNumber && remote && token) {
    console.error(`   PR #${prNumber} found — generating full report...`);
    const data = await fetchAllPRData(remote.owner, remote.repo, prNumber, token, token);
    const base: PRRendererOptions = {
      owner: remote.owner, repo: remote.repo,
      pullNumber: prNumber, token, outputPath: "",
      graphqlToken: token, includeResolvedThreads: true, fetchCheckAnnotations: true,
      gitRoot,
    };
    const reviewPath   = join(outputDir, `PR-${prNumber}-review.md`);
    const reportPath   = join(outputDir, `PR-${prNumber}-report.md`);
    const conflictPath = join(outputDir, `PR-${prNumber}-conflicts.md`);

    await renderPR(data, { ...base, outputPath: reviewPath });
    await renderReport(data, { ...base, outputPath: reportPath });
    await renderLocalConflicts(dir, conflictFiles, conflictPath, prNumber,
      { baseBranch: data.pr.base.ref, headBranch: data.pr.head.ref });

    console.error(`\n✓  ${outputDir}`);
    console.error(`   • PR-${prNumber}-review.md`);
    console.error(`   • PR-${prNumber}-report.md`);
    console.error(`   • PR-${prNumber}-conflicts.md`);
  } else {
    const safeBranch   = branch ? branch.replace(/\//g, "-") : null;
    const label        = safeBranch ? `branch-${safeBranch}` : `conflict`;
    const conflictPath = join(outputDir, `${label}-conflicts.md`);
    await renderLocalConflicts(dir, conflictFiles, conflictPath, 0,
      { baseBranch: branch ?? "base", headBranch: "HEAD" });
    console.error(`\n✓  ${conflictPath}`);
    if (!token) console.error(`   Tip: set GITHUB_TOKEN to auto-link to a PR`);
  }
}

// ─── Install / Uninstall ──────────────────────────────────────────────────────

const HOOK_NAME = "git-print-conflicts";

function addToGlobalGitignore(entry: string): void {
  let ignorePath: string;
  try {
    ignorePath = execSync("git config --global core.excludesFile", {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch { ignorePath = ""; }

  if (!ignorePath) {
    ignorePath = join(process.env.HOME ?? "~", ".gitignore_global");
    execSync(`git config --global core.excludesFile "${ignorePath}"`, { stdio: "inherit" });
  }

  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, "utf-8") : "";
  if (existing.split("\n").some(l => l.trim() === entry.trim())) {
    console.log(`✓  ${entry} already in ${ignorePath}`);
    return;
  }
  writeFileSync(ignorePath, existing.trimEnd() + `\n${entry}\n`);
  console.log(`✓  Added ${entry} to ${ignorePath}`);
}

// ─── CI-failure reporter workflow ────────────────────────────────────────────

const CI_WORKFLOW_REL = ".github/workflows/git-print-ci-status.yml";
const CI_WORKFLOW_MARKER = "# git-print:ci-status";

// Written verbatim into each repo. GitHub Actions expressions use ${{ ... }} —
// escaped here as \${{ so this JS template literal doesn't interpolate them.
const CI_WORKFLOW_YAML = `name: Git-Print CI Status
${CI_WORKFLOW_MARKER}
#
# Auto-installed by \`git-print install\`. When a watched CI workflow FAILS on a
# pull request, this builds a CI-failure report (status, failure annotations +
# extracted job logs, changed files, commits) and uploads it as the
# "Git-Print-CI-Status" artifact.
#
#   * EDIT workflows: below to match the name: of YOUR CI workflow(s). Default "CI".
#   * This file must exist on the repo's DEFAULT branch to take effect.
#   * workflow_run is the only trigger that can observe GitHub-Actions CI failures.

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

permissions:
  contents: read
  pull-requests: read
  checks: read
  actions: read

jobs:
  report:
    if: \${{ github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.event == 'pull_request' }}
    runs-on: ubuntu-latest
    steps:
      - name: Install git-print
        run: npm install -g github:itstanner5216/Git-Print

      - name: Resolve PR number
        id: pr
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          PR=$(jq -r '.[0].number // empty' <<< '\${{ toJSON(github.event.workflow_run.pull_requests) }}')
          if [ -z "$PR" ]; then
            PR=$(gh api "repos/\${{ github.repository }}/commits/\${{ github.event.workflow_run.head_sha }}/pulls" --jq '.[0].number // empty' 2>/dev/null || true)
          fi
          echo "number=$PR" >> "$GITHUB_OUTPUT"
          if [ -n "$PR" ]; then echo "Resolved PR #$PR"; else echo "No PR for this run — nothing to report."; fi

      - name: Generate CI failure report
        if: steps.pr.outputs.number != ''
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: |
          git-print ci-status --pr "\${{ steps.pr.outputs.number }}" --sha "\${{ github.event.workflow_run.head_sha }}" --out Git-Print-CI-Status.md

      - name: Upload report artifact
        if: steps.pr.outputs.number != ''
        uses: actions/upload-artifact@v4
        with:
          name: Git-Print-CI-Status
          path: Git-Print-CI-Status.md
`;

function repoIsGit(path: string): boolean {
  try { execSync("git rev-parse --git-dir", { cwd: path, stdio: ["pipe", "pipe", "pipe"] }); return true; }
  catch { return false; }
}

function repoHasGitHubRemote(path: string): boolean {
  try {
    const out = execSync("git remote -v", { cwd: path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }) as string;
    return /github\.com[:/]/.test(out);
  } catch { return false; }
}

/**
 * Write the CI-failure reporter workflow into every registered repo that is a
 * git repo with a GitHub remote. Idempotent (overwrites our own file). Files are
 * left UNTRACKED — the user commits + pushes to the default branch to activate.
 */
function writeCiWorkflows(dryRun = false): void {
  const repos = getRepos();
  if (repos.length === 0) {
    console.log("   (no repos registered — run: git-print add <alias> <path>)");
    return;
  }
  let wrote = 0, updated = 0, skipped = 0;
  for (const { alias, path } of repos) {
    const label = alias.padEnd(20);
    if (!existsSync(path))          { console.log(`   ⫯ ${label} path missing — skipped`); skipped++; continue; }
    if (!repoIsGit(path))           { console.log(`   ⫯ ${label} not a git repo — skipped`); skipped++; continue; }
    if (!repoHasGitHubRemote(path)) { console.log(`   ⫯ ${label} no github.com remote — skipped`); skipped++; continue; }
    const dest = join(path, CI_WORKFLOW_REL);
    const existed = existsSync(dest);
    if (existed) updated++; else wrote++;
    if (dryRun) { console.log(`   ${existed ? "↻" : "✓"} ${label} ${dest}  (dry-run)`); continue; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, CI_WORKFLOW_YAML);
    console.log(`   ${existed ? "↻ updated" : "✓ wrote  "} ${label} ${dest}`);
  }
  console.log(`\n   ${dryRun ? "[dry-run] " : ""}${wrote} written, ${updated} updated, ${skipped} skipped.`);
  if (wrote + updated > 0 && !dryRun) {
    console.log(`   ⚠ Files are UNTRACKED — commit + push to each repo's DEFAULT branch to activate.`);
    console.log(`   ⚠ The workflow installs git-print from github:itstanner5216/Git-Print, so the`);
    console.log(`     'ci-status' command must be on that repo's default branch first.`);
  }
}

function installConflictHook(): void {
  const { major, minor } = getGitVersion();
  const hasConfigHooks = major > 2 || (major === 2 && minor >= 54);
  if (hasConfigHooks) {
    execSync(`git config --global hook.${HOOK_NAME}.event pre-push`, { stdio: "inherit" });
    execSync(`git config --global "hook.${HOOK_NAME}.command" "git-print auto"`, { stdio: "inherit" });
    console.log(`   ✓ git ${major}.${minor} config-based pre-push hook (global)`);
  } else {
    const gitRoot  = getGitRoot(process.cwd());
    const hookPath = join(gitCommonDir(gitRoot), "hooks", "pre-push");
    const marker   = "# git-print auto";
    if (existsSync(hookPath)) {
      const src = readFileSync(hookPath, "utf-8") as string;
      if (src.includes(marker)) { console.log(`   ✓ already in ${hookPath}`); return; }
      writeFileSync(hookPath, `${src.trimEnd()}\n\n${marker}\ngit ls-files -u | grep -q . && git-print auto\n`);
      console.log(`   ✓ appended to ${hookPath}`);
    } else {
      writeFileSync(hookPath, `#!/bin/bash\n${marker}\ngit ls-files -u | grep -q . && git-print auto\nexit 0\n`);
      chmodSync(hookPath, 0o755);
      console.log(`   ✓ created ${hookPath}`);
    }
  }
}

// ─── CLI launcher: make `git-print` runnable, independent of node version ──────
//
// `npm link` / `npm i -g` place the binary in the ACTIVE node's global bin dir.
// Under a version manager (nvm, vite-plus, volta, asdf …) that dir changes with
// every node switch, so the command silently drops off PATH — and repeated
// linking scatters copies across several node dirs. This installs ONE launcher
// at ONE deterministic, node-independent path: a symlink (or, where symlinks are
// unavailable, a tiny wrapper) to the built dist/cli.js, run by whatever `node`
// is on PATH via its shebang.
//
// Idempotent by contract: run it any number of times and it always converges to
// exactly one clean launcher at the same path. Already correct → it does nothing.
// A foreign file already at that path is never clobbered. Portable for every
// user — no machine-specific paths, honors $GIT_PRINT_BIN_DIR, and if the dir
// isn't on PATH it only PRINTS the line to add (never edits your profile).

const LAUNCHER_MARKER = "# git-print-launcher";

/** The single, node-independent install location for the `git-print` command.
 *  Deterministic per environment: $GIT_PRINT_BIN_DIR, else the user bin dir. */
function cliLauncherDir(): string {
  const override = (process.env.GIT_PRINT_BIN_DIR || "").trim();
  return override || join(homedir(), ".local", "bin");
}

/** Absolute path to the built CLI entry — this module at runtime (dist/cli.js),
 *  resolved through symlinks so it's identical however git-print was invoked. */
function cliEntryPath(): string {
  return fileURLToPath(import.meta.url);
}

/** A launcher WE own: a symlink to some …/cli.js, or a wrapper with our marker. */
function isOurLauncher(p: string): boolean {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return /(?:^|[\\/])cli\.js$/.test(readlinkSync(p));
    if (st.isFile()) return readFileSync(p, "utf-8").includes(LAUNCHER_MARKER);
  } catch { /* nothing there */ }
  return false;
}

/** True when the launcher already points exactly at `entry` (nothing to do). */
function launcherMatches(p: string, entry: string): boolean {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return readlinkSync(p) === entry;
    if (st.isFile()) { const t = readFileSync(p, "utf-8"); return t.includes(LAUNCHER_MARKER) && t.includes(entry); }
  } catch { /* nothing there */ }
  return false;
}

/** Anything at all at this path, including a broken symlink. */
function pathPresent(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

function installCliLauncher(dryRun = false): void {
  const dir = cliLauncherDir();
  const entry = cliEntryPath();
  const launcher = join(dir, "git-print");
  const onPath = (process.env.PATH || "").split(":").some((p) => p === dir);
  const printPathHint = () => console.log(onPath
    ? `   ✓ ${dir} is on your PATH`
    : `   ⚠ ${dir} is not on your PATH — add it, then restart your shell:\n       export PATH="${dir}:$PATH"`);

  // Already correct → no-op. Safe to run any number of times.
  if (launcherMatches(launcher, entry)) {
    console.log(`   ✓ already linked: ${launcher} → ${entry}`);
    printPathHint();
    return;
  }

  // A file we don't recognise sits at our path → never clobber it.
  if (pathPresent(launcher) && !isOurLauncher(launcher)) {
    console.log(`   ⚠ ${launcher} exists and isn't a git-print launcher — leaving it untouched.`);
    console.log(`     Set $GIT_PRINT_BIN_DIR to install elsewhere, or remove that file yourself.`);
    return;
  }

  if (dryRun) {
    console.log(`   ✓ would link ${launcher} → ${entry}  (dry-run)`);
    printPathHint();
    return;
  }

  try {
    mkdirSync(dir, { recursive: true });
    try { chmodSync(entry, 0o755); } catch { /* best effort */ }
    if (isOurLauncher(launcher)) { try { unlinkSync(launcher); } catch { /* recreated below */ } }
    try {
      symlinkSync(entry, launcher);
      console.log(`   ✓ linked ${launcher} → ${entry}`);
    } catch {
      // Symlinks unavailable (some filesystems / platforms) — wrapper instead.
      writeFileSync(launcher, `#!/bin/sh\n${LAUNCHER_MARKER}\nexec node "${entry}" "$@"\n`);
      chmodSync(launcher, 0o755);
      console.log(`   ✓ wrote launcher ${launcher} → node ${entry}`);
    }
  } catch (e: any) {
    console.log(`   ✗ could not install launcher in ${dir}: ${e.message}`);
    console.log(`     Do it manually:  ln -sf "${entry}" "${launcher}"`);
    return;
  }
  printPathHint();
}

function uninstallCliLauncher(): void {
  const launcher = join(cliLauncherDir(), "git-print");
  if (!isOurLauncher(launcher)) {
    console.log(pathPresent(launcher)
      ? `   ⚠ ${launcher} isn't a git-print launcher — leaving it untouched`
      : `   (no launcher at ${launcher})`);
    return;
  }
  try { unlinkSync(launcher); console.log(`   ✓ removed ${launcher}`); }
  catch (e: any) { console.log(`   ✗ could not remove ${launcher}: ${e.message}`); }
}

function runInstall(opts: { dryRun?: boolean; ciOnly?: boolean; cliOnly?: boolean } = {}): void {
  const { dryRun = false, ciOnly = false, cliOnly = false } = opts;
  console.log(dryRun ? "git-print install — DRY RUN (no changes written)\n" : "git-print install\n");

  if (!ciOnly) {
    console.log("Command-line launcher (makes `git-print` runnable, independent of node version):");
    installCliLauncher(dryRun);
    console.log("");
  }

  if (!ciOnly && !cliOnly && !dryRun) {
    console.log("Conflict reporter (global pre-push hook):");
    installConflictHook();
    addToGlobalGitignore(".git-print/");
    console.log("");
  }

  if (!cliOnly) {
    console.log(`CI-failure reporter (${CI_WORKFLOW_REL}) → registered repos:`);
    writeCiWorkflows(dryRun);
  }
  console.log(`\n   Idempotent — safe to re-run any time. Uninstall: git-print uninstall`);
}

function removeCiWorkflows(): void {
  let removed = 0;
  for (const { alias, path } of getRepos()) {
    const dest = join(path, CI_WORKFLOW_REL);
    if (!existsSync(dest)) continue;
    try {
      const src = readFileSync(dest, "utf-8") as string;
      if (src.includes(CI_WORKFLOW_MARKER)) {
        unlinkSync(dest);
        console.log(`   ✓ removed ${alias}: ${dest}`);
        removed++;
      }
    } catch { /* ignore */ }
  }
  console.log(`   CI workflow: ${removed} removed.`);
}

function uninstallConflictHook(): void {
  const { major, minor } = getGitVersion();
  const hasConfigHooks = major > 2 || (major === 2 && minor >= 54);
  if (hasConfigHooks) {
    try {
      execSync(`git config --global --remove-section hook.${HOOK_NAME}`, { stdio: "pipe" });
      console.log(`   ✓ removed hook from ~/.gitconfig`);
    } catch { console.log(`   (no hook in ~/.gitconfig)`); }
  } else {
    const gitRoot  = getGitRoot(process.cwd());
    const hookPath = join(gitCommonDir(gitRoot), "hooks", "pre-push");
    if (!existsSync(hookPath)) { console.log(`   (no pre-push hook found)`); return; }
    const filtered = (readFileSync(hookPath, "utf-8") as string)
      .split("\n")
      .filter((l: string) => !l.includes("git-print auto") && !l.includes("# git-print auto"))
      .join("\n");
    writeFileSync(hookPath, filtered);
    console.log(`   ✓ removed git-print lines from ${hookPath}`);
  }
}

function runUninstall(opts: { cliOnly?: boolean } = {}): void {
  const { cliOnly = false } = opts;
  console.log("git-print uninstall\n");
  console.log("Command-line launcher:");
  uninstallCliLauncher();
  if (!cliOnly) {
    console.log("\nConflict reporter (pre-push hook):");
    uninstallConflictHook();
    console.log(`\nCI-failure reporter (${CI_WORKFLOW_REL}):`);
    removeCiWorkflows();
  }
}

// ─── ci-status subcommand ───────────────────────────────────────────────────
//
// Designed to run *inside* a GitHub Actions job that fires only on CI failure
// (see the workflow written by `git-print install`). It renders the same report
// `renderReport` produces — CI status (failure annotations + extracted job
// logs), changed files, commits — to an explicit --out path so the job can
// upload it as an artifact.
// No local state, no polling, no daemon: the failing run builds the report
// server-side and you pull it from the run's artifacts.
async function runCiStatus(args: string[]): Promise<void> {
  let prNumber: number | null = null;
  let sha: string | null = null;
  let out = "Git-Print-CI-Status.md";
  let repoArg: string | null = null;
  let dir = process.cwd();
  let token: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--pr" && i + 1 < args.length) prNumber = parseInt(args[++i], 10);
    else if (a === "--sha" && i + 1 < args.length) sha = args[++i];
    else if ((a === "--out" || a === "-o") && i + 1 < args.length) out = args[++i];
    else if (a === "--repo" && i + 1 < args.length) repoArg = args[++i];
    else if (a === "--dir" && i + 1 < args.length) dir = args[++i];
    else if (a === "--token" && i + 1 < args.length) token = args[++i];
  }

  if (prNumber === null || Number.isNaN(prNumber)) {
    console.error("git-print ci-status: --pr <number> is required");
    process.exit(1);
  }

  // Fall back to env / the repo's .env (CI sets GH_TOKEN; locally read <repo>/.env)
  if (!token) {
    loadRepoEnv(dir);
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || null;
  }
  if (!token) {
    console.error("git-print ci-status: no token (set GITHUB_TOKEN / GH_TOKEN / GITHUB_PAT or --token).");
    process.exit(1);
  }

  // Resolve owner/repo: --repo > $GITHUB_REPOSITORY (set by Actions) > git remote.
  let owner: string, repo: string;
  if (repoArg && repoArg.includes("/")) {
    [owner, repo] = repoArg.split("/", 2);
  } else if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes("/")) {
    [owner, repo] = process.env.GITHUB_REPOSITORY.split("/", 2);
  } else {
    ({ owner, repo } = getGitHubRemote(getGitRoot(dir)));
  }

  console.error(`Git-Print CI status — ${owner}/${repo} PR #${prNumber}${sha ? ` @ ${sha.slice(0, 7)}` : ""}`);

  const data = await fetchAllPRData(owner, repo, prNumber, token, token);
  // Pin the check-runs lookup to the exact pushed commit when provided, so the
  // report reflects the run that failed even if the PR head advanced since.
  if (sha) data.pr.head.sha = sha;

  const parent = dirname(out);
  if (parent && parent !== ".") await mkdir(parent, { recursive: true });

  await renderReport(data, {
    owner, repo,
    pullNumber: prNumber,
    token,
    graphqlToken: token,
    outputPath: out,
    includeResolvedThreads: true,
    fetchCheckAnnotations: true,
  });
  console.error(`✓  Wrote CI status report → ${out}`);
}


// ─── Entry dispatch ────────────────────────────────────────────────────────────
// Placed last so every function + module-level const above is initialized before
// any subcommand runs (avoids temporal-dead-zone ReferenceErrors).

if (isEntry) {
  const args = process.argv.slice(2);
  const sub  = args[0];

  if (sub === "add" || sub === "list" || sub === "remove") {
    runSubcommand(args);
  } else if (sub === "auto") {
    runAuto().catch((e) => {
      console.error(`git-print auto: ${e.message}`);
      process.exit(0);
    });
  } else if (sub === "install") {
    runInstall({ dryRun: args.includes("--dry-run"), ciOnly: args.includes("--ci-only"), cliOnly: args.includes("--cli-only") });
  } else if (sub === "uninstall") {
    runUninstall({ cliOnly: args.includes("--cli-only") });
  } else if (sub === "ci-status") {
    runCiStatus(args.slice(1)).catch((e) => {
      console.error(`git-print ci-status: ${e.message}`);
      process.exit(1);
    });
  } else {
    main().catch((e) => {
      console.error(`Fatal: ${e.message}`);
      process.exit(1);
    });
  }
}
