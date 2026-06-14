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
import { execSync } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fetchAllPRData, fetchPRMetadata, renderPR, renderReport, renderConflicts, resolveConflicts, extractConflicts, gitCommonDir, } from "./pr-renderer.js";
function parseArgs() {
    const args = process.argv.slice(2);
    let prNumber = null;
    let token = null;
    let dir = process.cwd();
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
    // Resolve token: --token > $GITHUB_TOKEN > $GH_TOKEN > $GITHUB_PAT
    if (!token) {
        token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || null;
    }
    if (!token) {
        console.error("Error: No GitHub token found. Provide --token or set GITHUB_TOKEN, GH_TOKEN, or GITHUB_PAT.");
        process.exit(1);
    }
    return { prNumber, token, dir, reviewOnly, reportOnly, resolutions, bareBaseline, bareIncoming };
}
function printUsage() {
    console.error(`
Usage: print-pr-review <pr-number> [options]

Options:
  --token <token>          GitHub personal access token (default: $GITHUB_TOKEN or $GH_TOKEN)
  --dir <path>             Directory to detect git repo from (default: cwd)
  --review-only            Only generate the conversation review file
  --report-only            Only generate the CI/commits/files report
  --use-baseline <file>    Resolve conflicts in <file> using the base branch version (repeatable)
  --use-incoming <file>    Resolve conflicts in <file> using the PR branch version (repeatable)
  -h, --help               Show this help message

Conflict resolution:
  When --use-baseline or --use-incoming flags are present, the tool runs the
  merge in a sandbox worktree to verify the resolution is safe, then applies
  it to your current working tree. You must be on the PR head branch.
  If only one file conflicts, the filename can be omitted.
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
// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const { prNumber, token, dir, reviewOnly, reportOnly, resolutions, bareBaseline, bareIncoming, } = parseArgs();
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
                console.error(`  print-pr-review ${prNumber} --use-baseline file1 --use-incoming file2`);
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
                console.error(`\nExample: print-pr-review ${prNumber} --use-baseline ${conflictPaths[0]} --use-incoming ${conflictPaths[1]}`);
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
        // Auto-detect conflicts and generate conflict report
        if (pr.mergeable === false && pr.mergeable_state === "dirty") {
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
            // No conflicts — clean up stale conflict file if it exists
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
    main().catch((e) => {
        console.error(`Fatal: ${e.message}`);
        process.exit(1);
    });
}
