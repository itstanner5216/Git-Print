/**
 * config.ts — Git-Print plain-text config
 *
 * Config file location: ~/.config/git-print/config
 *
 * Format (Zenith-inspired):
 *
 *   # Git-Print Configuration
 *
 *   ## Repos
 *   zenith-mcp: /home/tanner/Projects/Zenith-MCP
 *   git-print: /home/tanner/Projects/Git-Print
 *
 *   ## Worktrees
 *   zenith-mcp/pr23-test: /home/tanner/Projects/Zenith-Worktrees/pr23-pr20-merge-test
 *
 *   ## Settings
 *   auto-discover-worktrees: enabled
 *
 * Commands:
 *   git-print add <alias> [path]         — register a repo (auto-detect path if omitted)
 *   git-print add <alias>/<wt> [path]    — register a worktree
 *   git-print list                        — show all registered repos + worktrees
 *   git-print remove <alias>             — remove a repo + its worktrees
 *   git-print remove <alias>/<wt>        — remove a single worktree
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
// ─── Config file path ─────────────────────────────────────────────────────────
export function configPath() {
    return join(homedir(), ".config", "git-print", "config");
}
// ─── Parser ───────────────────────────────────────────────────────────────────
function parse(text) {
    const entries = [];
    for (const line of text.split("\n")) {
        if (line.startsWith("## ")) {
            entries.push({ type: "section", name: line.slice(3).trim(), raw: line });
        }
        else if (line.startsWith("#")) {
            entries.push({ type: "comment", text: line });
        }
        else if (line.trim() === "") {
            entries.push({ type: "blank" });
        }
        else {
            const sep = line.indexOf(": ");
            if (sep !== -1) {
                entries.push({ type: "kv", key: line.slice(0, sep), value: line.slice(sep + 2).trim(), raw: line });
            }
            else {
                entries.push({ type: "comment", text: line }); // preserve unknown lines
            }
        }
    }
    return entries;
}
function serialize(entries) {
    return entries.map(e => {
        switch (e.type) {
            case "section": return e.raw;
            case "comment": return e.text;
            case "blank": return "";
            case "kv": return `${e.key}: ${e.value}`;
        }
    }).join("\n");
}
// ─── Read / write ─────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = `# Git-Print Configuration

## Repos

## Worktrees

## Settings
auto-discover-worktrees: enabled
`;
function read() {
    const p = configPath();
    if (!existsSync(p))
        return parse(DEFAULT_CONFIG);
    return parse(readFileSync(p, "utf-8"));
}
function write(entries) {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, serialize(entries), "utf-8");
}
// ─── Section helpers ──────────────────────────────────────────────────────────
/**
 * Find the index range [start, end) of a section's KV entries.
 * start is the line AFTER the section header, end is the next section header or EOF.
 */
function sectionRange(entries, section) {
    const headerIdx = entries.findIndex(e => e.type === "section" && e.name === section);
    if (headerIdx === -1)
        return null;
    let end = entries.length;
    for (let i = headerIdx + 1; i < entries.length; i++) {
        if (entries[i].type === "section") {
            end = i;
            break;
        }
    }
    return { headerIdx, start: headerIdx + 1, end };
}
function getKV(entries, section, key) {
    const range = sectionRange(entries, section);
    if (!range)
        return undefined;
    for (let i = range.start; i < range.end; i++) {
        const e = entries[i];
        if (e.type === "kv" && e.key === key)
            return e.value;
    }
    return undefined;
}
function setKV(entries, section, key, value) {
    const range = sectionRange(entries, section);
    if (!range)
        throw new Error(`Section "${section}" not found in config`);
    // Update existing key
    for (let i = range.start; i < range.end; i++) {
        const e = entries[i];
        if (e.type === "kv" && e.key === key) {
            entries[i] = { type: "kv", key, value, raw: `${key}: ${value}` };
            return;
        }
    }
    // Insert before end of section (before next section header or EOF)
    // Find insertion point: just before range.end, skip trailing blanks within section
    let insertAt = range.end;
    // Insert after last KV in section, before trailing blanks/next section
    for (let i = range.start; i < range.end; i++) {
        if (entries[i].type === "kv")
            insertAt = i + 1;
    }
    entries.splice(insertAt, 0, { type: "kv", key, value, raw: `${key}: ${value}` });
}
function removeKV(entries, section, key) {
    const range = sectionRange(entries, section);
    if (!range)
        return false;
    for (let i = range.start; i < range.end; i++) {
        const e = entries[i];
        if (e.type === "kv" && e.key === key) {
            entries.splice(i, 1);
            return true;
        }
    }
    return false;
}
function allKVInSection(entries, section) {
    const range = sectionRange(entries, section);
    if (!range)
        return [];
    const result = [];
    for (let i = range.start; i < range.end; i++) {
        const e = entries[i];
        if (e.type === "kv")
            result.push({ key: e.key, value: e.value });
    }
    return result;
}
// ─── Git repo root detection ──────────────────────────────────────────────────
export function detectRepoRoot(fromDir = process.cwd()) {
    try {
        const root = execFileSync("git", ["-C", fromDir, "rev-parse", "--show-toplevel"], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return root || null;
    }
    catch {
        return null;
    }
}
// ─── Auto-discover worktrees ──────────────────────────────────────────────────
function autoDiscoverWorktrees(repoPath) {
    try {
        const output = execFileSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        const worktrees = [];
        const blocks = output.trim().split(/\n\n+/);
        for (const block of blocks) {
            const lines = block.split("\n");
            const pathLine = lines.find(l => l.startsWith("worktree "));
            if (!pathLine)
                continue;
            const wtPath = pathLine.slice("worktree ".length).trim();
            if (wtPath === repoPath)
                continue; // skip main worktree
            const name = wtPath.split("/").pop() ?? wtPath;
            worktrees.push({ name, path: wtPath });
        }
        return worktrees;
    }
    catch {
        return [];
    }
}
// ─── Public API ──────────────────────────────────────────────────────────────
/** Add or update a repo alias. */
export function addRepo(alias, repoPath) {
    const path = repoPath ?? detectRepoRoot();
    if (!path)
        throw new Error("No path given and couldn't detect a git repo in cwd");
    const entries = read();
    setKV(entries, "Repos", alias, path);
    write(entries);
    console.log(`✓ Registered repo: ${alias} → ${path}`);
}
/** Add or update a worktree alias. Key format: "alias/worktree-name". */
export function addWorktree(alias, worktreeName, wtPath) {
    const path = wtPath ?? process.cwd();
    const key = `${alias}/${worktreeName}`;
    const entries = read();
    // Ensure the repo exists
    const repoPath = getKV(entries, "Repos", alias);
    if (!repoPath)
        throw new Error(`Repo "${alias}" not registered. Run: git-print add ${alias} <path>`);
    setKV(entries, "Worktrees", key, path);
    write(entries);
    console.log(`✓ Registered worktree: ${key} → ${path}`);
}
/** Remove a repo and all its worktrees, or just a single worktree. */
export function remove(target) {
    const entries = read();
    if (target.includes("/")) {
        // Remove single worktree
        const removed = removeKV(entries, "Worktrees", target);
        if (!removed)
            throw new Error(`Worktree "${target}" not found in config`);
        write(entries);
        console.log(`✓ Removed worktree: ${target}`);
    }
    else {
        // Remove repo + all its worktrees
        const repoRemoved = removeKV(entries, "Repos", target);
        if (!repoRemoved)
            throw new Error(`Repo "${target}" not found in config`);
        // Remove all worktrees prefixed with alias/
        const wts = allKVInSection(entries, "Worktrees")
            .filter(kv => kv.key.startsWith(`${target}/`));
        for (const wt of wts)
            removeKV(entries, "Worktrees", wt.key);
        write(entries);
        const wtMsg = wts.length ? ` + ${wts.length} worktree${wts.length > 1 ? "s" : ""}` : "";
        console.log(`✓ Removed repo: ${target}${wtMsg}`);
    }
}
/** Resolve --repo [--worktree] into an absolute directory path. */
export function resolve(alias, worktreeName) {
    const entries = read();
    if (worktreeName) {
        const key = `${alias}/${worktreeName}`;
        const path = getKV(entries, "Worktrees", key);
        if (path)
            return path;
        // Try auto-discovery if enabled
        const autoDiscover = getKV(entries, "Settings", "auto-discover-worktrees");
        if (autoDiscover === "enabled") {
            const repoPath = getKV(entries, "Repos", alias);
            if (repoPath) {
                const discovered = autoDiscoverWorktrees(repoPath);
                const match = discovered.find(wt => wt.name === worktreeName);
                if (match)
                    return match.path;
            }
        }
        throw new Error(`Worktree "${alias}/${worktreeName}" not found. Run: git-print add ${alias}/${worktreeName} <path>`);
    }
    const path = getKV(entries, "Repos", alias);
    if (!path)
        throw new Error(`Repo "${alias}" not registered. Run: git-print add ${alias} <path>`);
    return path;
}
/** Print a human-readable list of all registered repos + worktrees. */
export function list() {
    const entries = read();
    const repos = allKVInSection(entries, "Repos");
    const worktrees = allKVInSection(entries, "Worktrees");
    const settings = allKVInSection(entries, "Settings");
    const autoDiscover = settings.find(s => s.key === "auto-discover-worktrees")?.value === "enabled";
    if (repos.length === 0) {
        console.log("No repos registered yet.\nRun: git-print add <alias> <path>");
        return;
    }
    console.log("\nRegistered repos:\n");
    for (const repo of repos) {
        console.log(`  ${repo.key.padEnd(20)} ${repo.value}`);
        // Show registered worktrees for this repo
        const repoWts = worktrees.filter(wt => wt.key.startsWith(`${repo.key}/`));
        for (const wt of repoWts) {
            const wtName = wt.key.slice(repo.key.length + 1);
            console.log(`    ↳ ${wtName.padEnd(18)} ${wt.value}`);
        }
        // Show auto-discovered worktrees if enabled
        if (autoDiscover) {
            const discovered = autoDiscoverWorktrees(repo.value);
            const registeredPaths = new Set(repoWts.map(wt => wt.value));
            const unregistered = discovered.filter(wt => !registeredPaths.has(wt.path));
            for (const wt of unregistered) {
                console.log(`    ↳ ${wt.name.padEnd(18)} ${wt.path}  (auto-discovered)`);
            }
        }
    }
    console.log(`\nConfig: ${configPath()}`);
    if (autoDiscover)
        console.log("Auto-discover worktrees: enabled");
}
