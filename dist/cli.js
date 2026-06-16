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
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchAllPRData, fetchPRMetadata, fetchAllPages, renderPR, renderReport, renderConflicts, resolveConflicts, extractConflicts, gitCommonDir, } from "./pr-renderer.js";
import { addRepo, addWorktree, remove as removeConfig, list as listConfig, resolve as resolveAlias, } from "./config.js";
function parseArgs() {
    const args = process.argv.slice(2);
    let prNumber = null;
    let token = null;
    let dir = process.cwd();
    let repo = null;
    let worktree = null;
    let reviewOnly = false;
    let reportOnly = false;
    const resolutions = new Map();
    let bareBaseline = false;
    let bareIncoming = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--token" && i + 1 < args.length) {
            token = args[++i];
        }
        else if (arg === "--dir" && i + 1 < args.length) {
            dir = args[++i];
        }
        else if (arg === "--repo" && i + 1 < args.length) {
            repo = args[++i];
        }
        else if (arg === "--worktree" && i + 1 < args.length) {
            worktree = args[++i];
        }
        else if (arg === "--review-only") {
            reviewOnly = true;
        }
        else if (arg === "--report-only") {
            reportOnly = true;
        }
        else if (arg === "--use-baseline") {
            // Check if next arg is a filename (not another flag or missing)
            if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                resolutions.set(args[++i], "baseline");
            }
            else {
                bareBaseline = true;
            }
        }
        else if (arg === "--use-incoming") {
            if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                resolutions.set(args[++i], "incoming");
            }
            else {
                bareIncoming = true;
            }
        }
        else if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        }
        else if (!arg.startsWith("-") && prNumber === null) {
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
        }
        catch (e) {
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
function printUsage() {
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
                        (default: \$GITHUB_TOKEN, \$GH_TOKEN, or \$GITHUB_PAT)
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

AUTO CONFLICT DETECTION  (pre-push hook)
  git-print install     Install the pre-push hook
                        git >= 2.54: config-based hook in ~/.gitconfig (global)
                        git <  2.54: shell script in .git/hooks/pre-push
  git-print uninstall   Remove the hook
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
function getGitRoot(fromDir) {
    try {
        return execSync("git rev-parse --show-toplevel", {
            cwd: fromDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    }
    catch {
        console.error(`Error: Not a git repository (or any parent up to mount point): ${fromDir}`);
        process.exit(1);
    }
}
function getOutputDir(gitRoot) {
    const gitDir = execSync("git rev-parse --path-format=absolute --git-dir", {
        cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const commonDir = gitCommonDir(gitRoot);
    return gitDir !== commonDir
        ? join(gitRoot, ".git-print") // worktree
        : join(commonDir, "Git-Print"); // main repo
}
function getCurrentBranch(fromDir) {
    try {
        return execSync("git branch --show-current", {
            cwd: fromDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim() || null;
    }
    catch {
        return null;
    }
}
function getGitVersion() {
    try {
        const raw = execSync("git --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        // "git version 2.54.1" → [2, 54]
        const m = raw.match(/(\d+)\.(\d+)/);
        if (!m)
            return { major: 0, minor: 0 };
        return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
    }
    catch {
        return { major: 0, minor: 0 };
    }
}
/**
 * Find the open PR number for the current branch using the same
 * fetchAllPages pattern used throughout git-print.
 */
async function findPRForBranch(owner, repo, branch, token) {
    try {
        const prs = await fetchAllPages(`/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open&per_page=1`, token);
        return prs.length > 0 ? prs[0].number : null;
    }
    catch {
        return null;
    }
}
/**
 * Redact userinfo (user:pass@) from a URL so credentials don't leak in error messages.
 * Works on URLs that may or may not parse via URL().
 */
function redactUrl(url) {
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
export function parseGitHubRemote(url) {
    // Normalize SCP-style "git@github.com:owner/repo" → "ssh://git@github.com/owner/repo"
    let normalized = url.trim();
    const scp = normalized.match(/^(?:[^@\s:/]+@)?([^\s:/]+):([^\s].*)$/);
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized);
    if (!isUrl && scp) {
        normalized = `ssh://${normalized.replace(":", "/")}`;
    }
    let host;
    let path;
    try {
        const u = new URL(normalized);
        host = u.hostname;
        path = u.pathname;
    }
    catch {
        // Last-ditch: pull out everything after a github.com[:/] separator
        const m = normalized.match(/github\.com[:/](.+)$/i);
        if (!m)
            return null;
        host = "github.com";
        path = "/" + m[1];
    }
    if (!/github\.com$/i.test(host))
        return null;
    // Strip leading slash, then strip exactly one trailing ".git"
    let pathStr = path.replace(/^\/+/, "");
    if (pathStr.endsWith(".git"))
        pathStr = pathStr.slice(0, -4);
    const parts = pathStr.split("/").filter(Boolean);
    if (parts.length < 2)
        return null;
    const owner = parts[0];
    // Repo name is everything after owner (collapsed) — GitHub repos are owner/repo
    // but allow paths like owner/repo/anything (we ignore the tail).
    const repo = parts[1];
    if (!owner || !repo)
        return null;
    return { owner, repo };
}
function getGitHubRemote(gitRoot) {
    let remoteUrl;
    try {
        remoteUrl = execSync("git remote get-url origin", {
            cwd: gitRoot,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    }
    catch {
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
function tryGetGitHubRemote(gitRoot) {
    try {
        const remoteUrl = execSync("git remote get-url origin", {
            cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return parseGitHubRemote(remoteUrl);
    }
    catch {
        return null;
    }
}
// ─── Subcommand handler ─────────────────────────────────────────────────────
/**
 * Handle config subcommands (add / list / remove) and exit.
 * Called before parseArgs() so these commands never need a PR number or token.
 */
function runSubcommand(args) {
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
        }
        catch (e) {
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
        const explicitPath = rest[1]; // may be undefined → auto-detect
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
            }
            else {
                addRepo(target, explicitPath);
            }
        }
        catch (e) {
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
function detectLocalConflicts(dir) {
    try {
        const out = execSync("git diff --name-only --diff-filter=U", {
            cwd: dir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return out ? out.split("\n").filter(Boolean) : [];
    }
    catch {
        return [];
    }
}
function parseConflictRegions(content) {
    const lines = content.split("\n");
    const regions = [];
    let i = 0;
    while (i < lines.length) {
        if (!lines[i].startsWith("<<<<<<< ")) {
            i++;
            continue;
        }
        const start = i;
        let ancStart = -1, sep = -1, end = -1, j = i + 1;
        while (j < lines.length) {
            const l = lines[j];
            if (l.startsWith("||||||| ") && ancStart === -1 && sep === -1)
                ancStart = j;
            else if (l === "=======" && sep === -1)
                sep = j;
            else if (l.startsWith(">>>>>>> ")) {
                end = j;
                break;
            }
            j++;
        }
        if (sep === -1 || end === -1) {
            i = start + 1;
            continue;
        } // malformed — skip
        regions.push({
            start, ancStart, sep, end,
            oursLabel: lines[start].slice(8).trim(),
            theirsLabel: lines[end].slice(8).trim(),
        });
        i = end + 1;
    }
    return regions;
}
/**
 * Render a local-conflict markdown report directly from working-tree files.
 * Each conflict becomes a single line-numbered ```diff fence using the REAL
 * editor line numbers (the ones you jump to to fix it), with ours = `-`,
 * theirs = `+`, and the literal git markers turned into labeled full-width
 * rules so they're impossible to miss. Local-state equivalent of
 * renderConflicts() — fires whenever `git diff` shows unmerged files,
 * regardless of GitHub's pr.mergeable value.
 */
async function renderLocalConflicts(dir, conflictPaths, outputPath, prNumber, context) {
    const CONTEXT = 3;
    const RULE_WIDTH = 66;
    const currentBranch = getCurrentBranch(dir);
    const files = [];
    for (const relPath of conflictPaths) {
        const fullPath = join(dir, relPath);
        try {
            const stat = statSync(fullPath);
            if (stat.size > 512_000) {
                files.push({ path: relPath, regions: [], lines: [], oversized: true, binary: false });
                continue;
            }
            const content = readFileSync(fullPath, "utf-8");
            if (content.includes("\u0000")) {
                files.push({ path: relPath, regions: [], lines: [], oversized: false, binary: true });
                continue;
            }
            files.push({
                path: relPath,
                regions: parseConflictRegions(content),
                lines: content.split("\n"),
                oversized: false, binary: false,
            });
        }
        catch {
            files.push({ path: relPath, regions: [], lines: [], oversized: false, binary: false });
        }
    }
    const totalRegions = files.reduce((s, f) => s + f.regions.length, 0);
    const firstRegion = files.find(f => f.regions.length > 0)?.regions[0];
    const oursName = currentBranch ?? context.baseBranch;
    const theirsName = (context.headBranch && context.headBranch !== "HEAD")
        ? context.headBranch
        : (firstRegion?.theirsLabel ?? context.headBranch);
    const out = [];
    const w = (line = "") => out.push(line);
    // ── Header ──
    w(`# ⚠ Merge Conflicts${prNumber > 0 ? ` — PR #${prNumber}` : ""}`);
    w();
    w(`\`${theirsName}\` does not merge cleanly into \`${oursName}\``);
    w();
    w(`**${files.length}** conflicting file${files.length !== 1 ? "s" : ""} · **${totalRegions}** conflict region${totalRegions !== 1 ? "s" : ""}`);
    w();
    w(`> **OURS** = your branch (\`${oursName}\`) · **THEIRS** = incoming (\`${theirsName}\`) · **BASE** = common ancestor _(shown only with diff3 / zdiff3 conflict style)_`);
    w(`>`);
    w(`> Gutter numbers are the real file line numbers. \`-\` is ours, \`+\` is theirs.`);
    w();
    w("---");
    const rule = (prefix, ch) => {
        const pad = Math.max(3, RULE_WIDTH - prefix.length);
        return `${prefix} ${ch.repeat(pad)}`;
    };
    for (const file of files) {
        w();
        const badge = file.oversized ? "⚠ oversized"
            : file.binary ? "binary"
                : `${file.regions.length} conflict${file.regions.length !== 1 ? "s" : ""}`;
        w(`## 📁 \`${file.path}\`  ·  ${badge}`);
        w();
        if (file.oversized) {
            w("> File exceeds 500 KB — content not shown.");
            continue;
        }
        if (file.binary) {
            w("> Binary file — no inline diff.");
            continue;
        }
        if (file.regions.length === 0) {
            w("> No inline conflict markers (delete/modify or rename conflict).");
            continue;
        }
        for (let r = 0; r < file.regions.length; r++) {
            const rg = file.regions[r];
            const oursCount = (rg.ancStart !== -1 ? rg.ancStart : rg.sep) - rg.start - 1;
            const theirsCount = rg.end - rg.sep - 1;
            let cls;
            if (oursCount === 0)
                cls = `🟢 Incoming adds ${theirsCount} line${theirsCount !== 1 ? "s" : ""}; ours is empty here.`;
            else if (theirsCount === 0)
                cls = `🔴 Incoming deletes ${oursCount} line${oursCount !== 1 ? "s" : ""} that ours keeps.`;
            else
                cls = `⚡ Both sides edited this span${rg.ancStart !== -1 ? " (ancestor shown)" : ""}.`;
            w(`### Conflict ${r + 1} of ${file.regions.length} · lines ${rg.start + 1}–${rg.end + 1}`);
            w();
            w(`> ${cls}`);
            w();
            const ctxStart = Math.max(0, rg.start - CONTEXT);
            const ctxEnd = Math.min(file.lines.length - 1, rg.end + CONTEXT);
            const width = String(ctxEnd + 1).length;
            const g = (n) => String(n).padStart(width);
            const oursLabel = (rg.oursLabel === "HEAD" && currentBranch) ? currentBranch : rg.oursLabel;
            const oursBoundary = rg.ancStart !== -1 ? rg.ancStart : rg.sep;
            w("```diff");
            for (let k = ctxStart; k <= ctxEnd; k++) {
                const ln = k + 1;
                const text = file.lines[k];
                if (k === rg.start) {
                    out.push(`${g(ln)}  ${rule(`<<<<<<< OURS · ${oursLabel}`, "═")}`);
                }
                else if (k === rg.ancStart) {
                    out.push(`${g(ln)}  ${rule("||||||| BASE · common ancestor", "─")}`);
                }
                else if (k === rg.sep) {
                    out.push(`${g(ln)}  ${rule(`======= THEIRS · ${rg.theirsLabel}`, "═")}`);
                }
                else if (k === rg.end) {
                    out.push(`${g(ln)}  ${rule(">>>>>>> END", "═")}`);
                }
                else {
                    let m = " ";
                    if (k > rg.start && k < oursBoundary)
                        m = "-"; // ours
                    else if (k > rg.sep && k < rg.end)
                        m = "+"; // theirs
                    out.push(`${g(ln)} ${m} ${text}`.replace(/\s+$/, ""));
                }
            }
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
        if (file.oversized)
            w(`| \`${file.path}\` | ⚠ oversized | — |`);
        else if (file.binary)
            w(`| \`${file.path}\` | binary | — |`);
        else if (file.regions.length === 0)
            w(`| \`${file.path}\` | delete/modify | — |`);
        else {
            const spans = file.regions.map(rr => `L${rr.start + 1}–${rr.end + 1}`).join(", ");
            w(`| \`${file.path}\` | ${file.regions.length} | ${spans} |`);
        }
    }
    w();
    w(`**Total:** ${files.length} file${files.length !== 1 ? "s" : ""} · ${totalRegions} conflict region${totalRegions !== 1 ? "s" : ""}`);
    w();
    await writeFile(outputPath, out.join("\n"), "utf-8");
    return outputPath;
}
// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const { prNumber, token, dir, repo: _repo, worktree: _worktree, reviewOnly, reportOnly, resolutions, bareBaseline, bareIncoming, } = parseArgs();
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
    const generatedPaths = [];
    // mkdir is deferred until we actually need to write — dry runs in particular
    // must not create or touch report directories.
    let outputDirReady = false;
    const ensureOutputDir = async () => {
        if (outputDirReady)
            return;
        await mkdir(outputDir, { recursive: true });
        outputDirReady = true;
    };
    // Determine if we need the full API fetch or just PR metadata.
    // Resolve mode only needs branch names unless review/report files are also requested.
    const needsFullFetch = !isResolveMode || reviewOnly || reportOnly;
    let data = null;
    let pr;
    if (needsFullFetch) {
        data = await fetchAllPRData(owner, repo, prNumber, token, token);
        pr = data.pr;
    }
    else {
        // Lightweight: single API call for branch names + merge status
        pr = await fetchPRMetadata(owner, repo, prNumber, token);
    }
    const baseOptions = {
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
                const side = bareIncoming ? "incoming" : "baseline";
                resolutions.set(conflictPaths[0], side);
                console.error(`Single conflicting file: ${conflictPaths[0]} → will use ${side}`);
            }
            else {
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
    }
    else {
        // ──── REPORT MODE (default) ────
        await ensureOutputDir();
        if (!reportOnly) {
            await renderPR(data, { ...baseOptions, outputPath: reviewPath });
            generatedPaths.push(reviewPath);
        }
        if (!reviewOnly) {
            await renderReport(data, { ...baseOptions, outputPath: reportPath });
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
            for (const f of localConflicts)
                console.error(`  • ${f}`);
            const baseBranch = pr.base?.ref ?? "base";
            const headBranch = pr.head?.ref ?? "head";
            await ensureOutputDir();
            const cPath = await renderLocalConflicts(dir, localConflicts, conflictPath, prNumber, { baseBranch, headBranch });
            generatedPaths.push(cPath);
            console.error(`Written conflict report to PR-${prNumber}-conflicts.md`);
        }
        else if (pr.mergeable === false && pr.mergeable_state === "dirty") {
            // No local conflicts but GitHub says the PR is dirty — run a trial merge
            const cPath = await renderConflicts(data, {
                ...baseOptions,
                outputPath: conflictPath,
                gitRoot,
            });
            if (cPath) {
                generatedPaths.push(cPath);
                console.error(`\n⚠ Merge conflicts detected — see PR-${prNumber}-conflicts.md`);
            }
        }
        else if (pr.mergeable === null) {
            console.error(`⚠ GitHub hasn't computed merge status yet. Skipping conflict report.`);
        }
        else {
            // No conflicts anywhere — clean up stale conflict file if it exists
            if (existsSync(conflictPath)) {
                try {
                    await unlink(conflictPath);
                }
                catch { /* fine */ }
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
    }
    catch {
        return true;
    }
})();
if (isEntry) {
    const args = process.argv.slice(2);
    const sub = args[0];
    if (sub === "add" || sub === "list" || sub === "remove") {
        runSubcommand(args);
    }
    else if (sub === "auto") {
        runAuto().catch((e) => {
            console.error(`git-print auto: ${e.message}`);
            process.exit(0);
        });
    }
    else if (sub === "install") {
        runInstall();
    }
    else if (sub === "uninstall") {
        runUninstall();
    }
    else {
        main().catch((e) => {
            console.error(`Fatal: ${e.message}`);
            process.exit(1);
        });
    }
}
// ─── Auto subcommand ──────────────────────────────────────────────────────────
async function runAuto() {
    const dir = process.cwd();
    const conflictFiles = detectLocalConflicts(dir);
    if (conflictFiles.length === 0)
        process.exit(0);
    console.error(`\n⚠  git-print: ${conflictFiles.length} unresolved conflict${conflictFiles.length !== 1 ? "s" : ""} detected`);
    for (const f of conflictFiles)
        console.error(`   • ${f}`);
    const gitRoot = getGitRoot(dir);
    const branch = getCurrentBranch(gitRoot);
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || null;
    let remote = null;
    remote = tryGetGitHubRemote(gitRoot);
    const outputDir = getOutputDir(gitRoot);
    await mkdir(outputDir, { recursive: true });
    let prNumber = null;
    if (remote && branch && token) {
        prNumber = await findPRForBranch(remote.owner, remote.repo, branch, token);
    }
    if (prNumber && remote && token) {
        console.error(`   PR #${prNumber} found — generating full report...`);
        const data = await fetchAllPRData(remote.owner, remote.repo, prNumber, token, token);
        const base = {
            owner: remote.owner, repo: remote.repo,
            pullNumber: prNumber, token, outputPath: "",
            graphqlToken: token, includeResolvedThreads: true, fetchCheckAnnotations: true,
        };
        const reviewPath = join(outputDir, `PR-${prNumber}-review.md`);
        const reportPath = join(outputDir, `PR-${prNumber}-report.md`);
        const conflictPath = join(outputDir, `PR-${prNumber}-conflicts.md`);
        await renderPR(data, { ...base, outputPath: reviewPath });
        await renderReport(data, { ...base, outputPath: reportPath });
        await renderLocalConflicts(dir, conflictFiles, conflictPath, prNumber, { baseBranch: data.pr.base.ref, headBranch: data.pr.head.ref });
        console.error(`\n✓  ${outputDir}`);
        console.error(`   • PR-${prNumber}-review.md`);
        console.error(`   • PR-${prNumber}-report.md`);
        console.error(`   • PR-${prNumber}-conflicts.md`);
    }
    else {
        const safeBranch = branch ? branch.replace(/\//g, "-") : null;
        const label = safeBranch ? `branch-${safeBranch}` : `conflict`;
        const conflictPath = join(outputDir, `${label}-conflicts.md`);
        await renderLocalConflicts(dir, conflictFiles, conflictPath, 0, { baseBranch: branch ?? "base", headBranch: "HEAD" });
        console.error(`\n✓  ${conflictPath}`);
        if (!token)
            console.error(`   Tip: set GITHUB_TOKEN to auto-link to a PR`);
    }
}
// ─── Install / Uninstall ──────────────────────────────────────────────────────
const HOOK_NAME = "git-print-conflicts";
function addToGlobalGitignore(entry) {
    let ignorePath;
    try {
        ignorePath = execSync("git config --global core.excludesFile", {
            encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    }
    catch {
        ignorePath = "";
    }
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
function runInstall() {
    const { major, minor } = getGitVersion();
    const hasConfigHooks = major > 2 || (major === 2 && minor >= 54);
    if (hasConfigHooks) {
        execSync(`git config --global hook.${HOOK_NAME}.event pre-push`, { stdio: "inherit" });
        execSync(`git config --global "hook.${HOOK_NAME}.command" "git-print auto"`, { stdio: "inherit" });
        console.log(`✓  Installed (git ${major}.${minor} — config-based hook, global, no files written)`);
        console.log(`   Runs git-print auto on every push across all repos.`);
        console.log(`   Uninstall: git-print uninstall`);
    }
    else {
        const gitRoot = getGitRoot(process.cwd());
        const hookPath = join(gitCommonDir(gitRoot), "hooks", "pre-push");
        // readFileSync, writeFileSync, chmodSync imported at top
        const marker = "# git-print auto";
        if (existsSync(hookPath)) {
            const src = readFileSync(hookPath, "utf-8");
            if (src.includes(marker)) {
                console.log(`✓  Already installed in ${hookPath}`);
                return;
            }
            writeFileSync(hookPath, `${src.trimEnd()}\n\n${marker}\ngit ls-files -u | grep -q . && git-print auto\n`);
            console.log(`✓  Appended to existing pre-push hook: ${hookPath}`);
        }
        else {
            writeFileSync(hookPath, `#!/bin/bash\n${marker}\ngit ls-files -u | grep -q . && git-print auto\nexit 0\n`);
            chmodSync(hookPath, 0o755);
            console.log(`✓  Created pre-push hook: ${hookPath}`);
        }
        console.log(`   (git 2.54+ supports a cleaner global config-based hook)`);
        console.log(`   Uninstall: git-print uninstall`);
    }
    // Add .git-print/ to global gitignore so worktree output dirs are never tracked
    addToGlobalGitignore(".git-print/");
}
function runUninstall() {
    const { major, minor } = getGitVersion();
    const hasConfigHooks = major > 2 || (major === 2 && minor >= 54);
    if (hasConfigHooks) {
        try {
            execSync(`git config --global --remove-section hook.${HOOK_NAME}`, { stdio: "pipe" });
            console.log(`✓  Removed hook from ~/.gitconfig`);
        }
        catch {
            console.log(`Nothing to remove — hook not found in ~/.gitconfig`);
        }
    }
    else {
        const gitRoot = getGitRoot(process.cwd());
        const hookPath = join(gitCommonDir(gitRoot), "hooks", "pre-push");
        if (!existsSync(hookPath)) {
            console.log(`Nothing to remove — no pre-push hook found`);
            return;
        }
        // readFileSync, writeFileSync imported at top
        const filtered = readFileSync(hookPath, "utf-8")
            .split("\n")
            .filter((l) => !l.includes("git-print auto") && !l.includes("# git-print auto"))
            .join("\n");
        writeFileSync(hookPath, filtered);
        console.log(`✓  Removed git-print lines from ${hookPath}`);
    }
}
