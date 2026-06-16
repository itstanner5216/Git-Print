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

import { execSync } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  fetchAllPRData, fetchPRMetadata, renderPR, renderReport, renderConflicts,
  resolveConflicts, extractConflicts, gitCommonDir,
} from "./pr-renderer.js";
import type { PRRendererOptions, PRData, PRMetadata } from "./pr-renderer.js";
import {
  addRepo, addWorktree, remove as removeConfig, list as listConfig,
  resolve as resolveAlias, detectRepoRoot,
} from "./config.js";

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

  // Resolve token: --token > $GITHUB_TOKEN > $GH_TOKEN > $GITHUB_PAT
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
  console.error(`
Usage: git-print <pr-number> [options]
       git-print add <alias> [path]
       git-print add <alias>/<worktree> [path]
       git-print list
       git-print remove <alias|alias/worktree>

Options:
  --token <token>          GitHub personal access token (default: $GITHUB_TOKEN or $GH_TOKEN)
  --dir <path>             Directory to detect git repo from (default: cwd)
  --repo <alias>           Use a registered repo alias instead of --dir
  --worktree <name>        Use a named worktree within --repo
  --review-only            Only generate the conversation review file
  --report-only            Only generate the CI/commits/files report
  --use-baseline <file>    Resolve conflicts in <file> using the base branch version (repeatable)
  --use-incoming <file>    Resolve conflicts in <file> using the PR branch version (repeatable)
  -h, --help               Show this help message

Repo aliases:
  git-print add zenith-mcp /path/to/repo   Register a repo alias
  git-print add zenith-mcp                  Auto-detect path from cwd
  git-print add zenith-mcp/pr23-test /wt    Register a worktree
  git-print list                            Show all registered repos
  git-print remove zenith-mcp              Remove repo + its worktrees

Conflict resolution:
  When --use-baseline or --use-incoming flags are present, the tool runs the
  merge in a sandbox worktree to verify the resolution is safe, then applies
  it to your current working tree. You must be on the PR head branch.
  If only one file conflicts, the filename can be omitted.
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
 * Minimal conflict marker parser — parses `<<<<<<<` / `=======` / `>>>>>>>`
 * blocks from a file's content. Handles optional 3-way ancestor markers (`|||||||`).
 */
function extractRegionsFromContent(content: string): Array<{
  startLine: number;
  endLine: number;
  baseContent: string;
  incomingContent: string;
  ancestorContent?: string;
  contextBefore: string[];
  contextAfter: string[];
}> {
  const CONTEXT = 3;
  const lines = content.split("\n");
  const regions: ReturnType<typeof extractRegionsFromContent> = [];

  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<< ")) { i++; continue; }

    const startLine = i + 1;  // 1-indexed
    const baseLines: string[] = [];
    const ancestorLines: string[] = [];
    const incomingLines: string[] = [];
    let hasAncestor = false;
    let phase: "base" | "ancestor" | "incoming" = "base";
    let endLine = i;

    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith("||||||| ")) {
        hasAncestor = true;
        phase = "ancestor";
      } else if (line === "=======") {
        phase = "incoming";
      } else if (line.startsWith(">>>>>>> ")) {
        endLine = i + 1;  // 1-indexed
        i++;
        break;
      } else {
        if (phase === "base") baseLines.push(line);
        else if (phase === "ancestor") ancestorLines.push(line);
        else incomingLines.push(line);
      }
      i++;
    }

    const ctxBeforeStart = Math.max(0, startLine - 1 - CONTEXT);
    const ctxAfterEnd   = Math.min(lines.length, endLine + CONTEXT);

    regions.push({
      startLine,
      endLine,
      baseContent: baseLines.join("\n"),
      incomingContent: incomingLines.join("\n"),
      ancestorContent: hasAncestor ? ancestorLines.join("\n") : undefined,
      contextBefore: lines.slice(ctxBeforeStart, startLine - 1),
      contextAfter:  lines.slice(endLine, ctxAfterEnd),
    });
  }
  return regions;
}

/**
 * Render a local-conflict markdown report directly from working-tree files.
 * This is the local-state equivalent of renderConflicts() — fires when
 * git diff shows unmerged files regardless of GitHub's pr.mergeable value.
 */
async function renderLocalConflicts(
  dir: string,
  conflictPaths: string[],
  outputPath: string,
  prNumber: number,
  context: { baseBranch: string; headBranch: string },
): Promise<string> {
  const { readFileSync, statSync } = await import("node:fs");
  const { writeFile } = await import("node:fs/promises");

  const files: Array<{ path: string; regions: ReturnType<typeof extractRegionsFromContent>; oversized: boolean }> = [];

  for (const relPath of conflictPaths) {
    const fullPath = join(dir, relPath);
    try {
      const stat = statSync(fullPath);
      if (stat.size > 512_000) {
        files.push({ path: relPath, regions: [], oversized: true });
        continue;
      }
      const content = readFileSync(fullPath, "utf-8");
      files.push({ path: relPath, regions: extractRegionsFromContent(content), oversized: false });
    } catch {
      files.push({ path: relPath, regions: [], oversized: false });
    }
  }

  const totalRegions = files.reduce((s, f) => s + f.regions.length, 0);
  const out: string[] = [];
  const w = (line = "") => out.push(line);

  w(`# ⚠ Merge Conflicts — PR #${prNumber}`);
  w();
  w(`\`${context.headBranch}\` cannot merge cleanly into \`${context.baseBranch}\``);
  w();
  w(`${files.length} conflicting file${files.length !== 1 ? "s" : ""} · ${totalRegions} conflict region${totalRegions !== 1 ? "s" : ""}`);
  w();
  w(`> **Source:** local working-tree conflict markers in \`${dir}\``);
  w();
  w("---");

  const langMap: Record<string, string> = {
    ts: "typescript", js: "javascript", py: "python", rs: "rust",
    go: "go", java: "java", kt: "kotlin", swift: "swift",
    cpp: "cpp", c: "c", cs: "csharp", rb: "ruby",
    md: "markdown", json: "json", yaml: "yaml", toml: "toml",
    sh: "bash", bash: "bash", zsh: "bash",
  };
  const langFor = (p: string) => langMap[p.split(".").pop() ?? ""] ?? "";

  for (const file of files) {
    const regionCount = file.oversized ? "⚠ oversized" : `${file.regions.length} conflict${file.regions.length !== 1 ? "s" : ""}`;
    w();
    w(`## 📁 ${file.path}  ·  ${regionCount}`);
    w();

    if (file.oversized) { w("> File exceeds 500KB — content not shown."); w(); continue; }
    if (file.regions.length === 0) { w("> Binary or deleted-vs-modified conflict — no inline markers."); w(); continue; }

    const lang = langFor(file.path);
    for (let r = 0; r < file.regions.length; r++) {
      const region = file.regions[r];
      w(`### Conflict ${r + 1} of ${file.regions.length} — Lines ${region.startLine}–${region.endLine}`);
      w();

      // Classify
      const baseEmpty = region.baseContent.trim() === "";
      const incomingEmpty = region.incomingContent.trim() === "";
      if (baseEmpty && !incomingEmpty)   w("> 🟢 Addition — incoming adds new content, baseline has nothing here.");
      else if (!baseEmpty && incomingEmpty) w("> 🔴 Deletion — incoming removes content present in baseline.");
      else if (region.ancestorContent !== undefined) w("> ⚡ Both modified — baseline and incoming both changed from the common ancestor.");
      else                                w("> ✏️ Both modified — baseline and incoming differ.");
      w();

      if (region.contextBefore.length > 0) {
        w("Context:"); w("```");
        for (const cl of region.contextBefore) w(cl);
        w("```"); w();
      }

      w(`**⬅ BASELINE** (\`${context.baseBranch}\`):`);
      w("```" + lang);
      w(region.baseContent);
      w("```"); w();

      if (region.ancestorContent !== undefined) {
        w(`**ANCESTOR** (common):`);
        w("```" + lang);
        w(region.ancestorContent);
        w("```"); w();
      }

      w(`**➡ INCOMING** (\`${context.headBranch}\`):`);
      w("```" + lang);
      w(region.incomingContent);
      w("```");

      if (region.contextAfter.length > 0) {
        w(); w("```");
        for (const cl of region.contextAfter) w(cl);
        w("```");
      }
      w();
    }
  }

  await writeFile(outputPath, out.join("\n"), "utf-8");
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
  const commonDir = gitCommonDir(gitRoot);
  const outputDir = join(commonDir, "Git-Print");

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
      const conflicts = extractConflicts(gitRoot, baseBranch, headBranch, {
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        pullNumber: prNumber,
      });
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
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
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
      // No local conflicts but GitHub says the PR is dirty — run a trial merge
      const cPath = await renderConflicts(data!, {
        ...baseOptions,
        outputPath: conflictPath,
        gitRoot,
      } as PRRendererOptions & { gitRoot: string });

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
// that exercise parseGitHubRemote).
const isEntry = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return entry.endsWith("cli.js") || entry.endsWith("cli.ts");
  } catch { return true; }
})();

if (isEntry) {
  const args = process.argv.slice(2);
  const sub = args[0];

  // Route config subcommands before anything else — they don’t need a PR number or token
  if (sub === "add" || sub === "list" || sub === "remove") {
    runSubcommand(args);
  } else {
    main().catch((e) => {
      console.error(`Fatal: ${e.message}`);
      process.exit(1);
    });
  }
}
