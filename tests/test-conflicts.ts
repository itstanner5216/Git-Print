#!/usr/bin/env node
/**
 * test-conflicts.ts — Integration tests for conflict detection & resolution
 *
 * Creates a temporary git repo with conflicting branches and exercises:
 *  1. parseConflictMarkers (via extractConflicts)
 *  2. extractConflicts
 *  3. validateInWorktree + applyResolutions (two-phase resolve)
 *  4. resolveConflicts (full flow)
 */

import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractConflicts,
  validateInWorktree,
  applyResolutions,
  resolveConflicts,
} from "../src/pr-renderer.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

// ─── Setup: create a local repo with conflicting branches ───────────────────

function createTestRepo(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "pr-conflict-test-"));

  // Init repo
  git("init -b main", tmpDir);
  git('config user.email "test@test.com"', tmpDir);
  git('config user.name "Test"', tmpDir);

  // Create initial files
  writeFileSync(join(tmpDir, "README.md"), "# Test Project\n\nInitial content.\n");
  writeFileSync(join(tmpDir, "config.ts"), `export const VERSION = "1.0.0";\nexport const API_URL = "https://api.example.com";\nexport const TIMEOUT = 5000;\n`);
  writeFileSync(join(tmpDir, "utils.ts"), `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n`);
  git("add -A", tmpDir);
  git('commit -m "Initial commit"', tmpDir);

  // Create base branch (simulates the PR base)
  git("checkout -b base-branch", tmpDir);
  writeFileSync(join(tmpDir, "config.ts"), `export const VERSION = "2.0.0";\nexport const API_URL = "https://api-v2.example.com";\nexport const TIMEOUT = 10000;\nexport const RETRY_COUNT = 3;\n`);
  writeFileSync(join(tmpDir, "utils.ts"), `export function greet(name: string): string {\n  return \`Hello, \${name}! Welcome back.\`;\n}\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n`);
  git("add -A", tmpDir);
  git('commit -m "Base branch changes: update config and utils"', tmpDir);

  // Create head branch (simulates the PR head) from main
  git("checkout main", tmpDir);
  git("checkout -b head-branch", tmpDir);
  writeFileSync(join(tmpDir, "config.ts"), `export const VERSION = "1.5.0";\nexport const API_URL = "https://staging.example.com";\nexport const TIMEOUT = 7500;\nexport const DEBUG = true;\n`);
  writeFileSync(join(tmpDir, "utils.ts"), `export function greet(name: string): string {\n  return \`Hi \${name}, how's it going?\`;\n}\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n`);
  git("add -A", tmpDir);
  git('commit -m "Head branch changes: different config and utils"', tmpDir);

  // Go back to main
  git("checkout main", tmpDir);

  return tmpDir;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

function testExtractConflicts(repoDir: string): void {
  console.log("\n── Test 1: extractConflicts ──");

  // extractConflicts uses `origin/base` and `origin/head`, so we need a remote.
  // For a local repo, we'll use the repo as its own remote.
  git(`remote add origin ${repoDir}`, repoDir);
  git("fetch origin", repoDir);

  const conflicts = extractConflicts(repoDir, "base-branch", "head-branch");

  assert(conflicts.length === 2, `Found ${conflicts.length} conflicting files (expected 2)`);

  const configConflict = conflicts.find(c => c.path === "config.ts");
  const utilsConflict = conflicts.find(c => c.path === "utils.ts");

  assert(configConflict !== undefined, "config.ts has conflicts");
  assert(utilsConflict !== undefined, "utils.ts has conflicts");

  if (configConflict) {
    assert(configConflict.regions.length > 0, `config.ts has ${configConflict.regions.length} conflict region(s)`);
    assert(!configConflict.oversized, "config.ts is not oversized");

    const region = configConflict.regions[0];
    assert(region.baseContent.length > 0, "config.ts base content is non-empty");
    assert(region.incomingContent.length > 0, "config.ts incoming content is non-empty");
    assert(region.startLine > 0, `config.ts conflict starts at line ${region.startLine}`);
    assert(region.endLine > region.startLine, `config.ts conflict ends at line ${region.endLine}`);
  }

  if (utilsConflict) {
    assert(utilsConflict.regions.length > 0, `utils.ts has ${utilsConflict.regions.length} conflict region(s)`);

    const region = utilsConflict.regions[0];
    assert(region.baseContent.length > 0, "utils.ts base content is non-empty");
    assert(region.incomingContent.length > 0, "utils.ts incoming content is non-empty");
  }
}

function testValidateAndResolve(repoDir: string): void {
  console.log("\n── Test 2: validateInWorktree ──");

  const resolutions = new Map<string, "baseline" | "incoming">();
  resolutions.set("config.ts", "baseline");
  resolutions.set("utils.ts", "incoming");

  const validation = validateInWorktree(repoDir, "base-branch", "head-branch", resolutions);

  assert(validation.status === "validated", `Validation status: ${validation.status} (expected validated)`);
  assert(validation.resolutionPlan.length === 2, `Resolution plan has ${validation.resolutionPlan.length} entries (expected 2)`);
  assert(validation.skipped.length === 0, `${validation.skipped.length} files skipped (expected 0)`);

  // Check index-state fingerprints are populated
  for (const entry of validation.resolutionPlan) {
    const fp = entry.fingerprint;
    if (fp.kind === "blob") {
      assert(!!fp.oid && fp.oid.length >= 7, `${entry.path} fingerprint has blob oid (${fp.oid})`);
      assert(!!fp.mode, `${entry.path} fingerprint has file mode (${fp.mode})`);
    } else {
      assert(fp.kind === "deleted", `${entry.path} fingerprint kind is deleted (chosen side removed file)`);
    }
  }

  if (validation.warnings.length > 0) {
    console.log(`  Warnings: ${validation.warnings.join("; ")}`);
  }
}

function testBadResolution(repoDir: string): void {
  console.log("\n── Test 3: validateInWorktree with bad file ──");

  const resolutions = new Map<string, "baseline" | "incoming">();
  resolutions.set("nonexistent.ts", "baseline");

  const validation = validateInWorktree(repoDir, "base-branch", "head-branch", resolutions);

  assert(validation.status === "failed", `Validation status: ${validation.status} (expected failed)`);
  assert(validation.warnings.length > 0, `Has warnings about nonexistent.ts`);
  if (validation.warnings.length > 0) {
    console.log(`    Warning: ${validation.warnings[0]}`);
  }
}

function testTypoDetection(repoDir: string): void {
  console.log("\n── Test 4: Typo detection (Levenshtein) ──");

  const resolutions = new Map<string, "baseline" | "incoming">();
  resolutions.set("confg.ts", "baseline");  // typo

  const validation = validateInWorktree(repoDir, "base-branch", "head-branch", resolutions);

  assert(validation.status === "failed", `Validation status: ${validation.status}`);
  const typoWarning = validation.warnings.find(w => w.includes("Did you mean"));
  assert(typoWarning !== undefined, `Typo detected: ${typoWarning || "(none)"}`);
}

function testFullResolve(repoDir: string): void {
  console.log("\n── Test 5: resolveConflicts (validate-then-apply flow) ──");

  // Caller must be on the PR head branch — that's where the merge commit lands.
  git("checkout head-branch", repoDir);

  // Make sure working tree is clean
  const status = git("status --porcelain", repoDir);
  assert(status === "", `Working tree is clean before resolve`);

  const headBefore = git("rev-parse HEAD", repoDir);

  const resolutions = new Map<string, "baseline" | "incoming">();
  resolutions.set("config.ts", "incoming");
  resolutions.set("utils.ts", "baseline");

  const result = resolveConflicts({
    gitRoot: repoDir,
    owner: "test",
    repo: "test",
    pullNumber: 99,
    token: "",
    base: "base-branch",
    head: "head-branch",
    resolutions,
  });

  assert(result.status === "committed", `Resolve result: ${result.status} (expected committed)`);
  if (result.status === "committed") {
    assert(result.resolved!.length === 2, `Resolved ${result.resolved!.length} files`);
    assert(result.commitMessage!.includes("PR #99"), `Commit message mentions PR #99`);
    assert(!!result.commitSha, `Commit SHA was returned: ${result.commitSha?.slice(0, 12)}`);

    // Commit landed on the user's current branch (head-branch)
    const headAfter = git("rev-parse HEAD", repoDir);
    assert(headAfter !== headBefore, `head-branch advanced (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)})`);
    assert(headAfter === result.commitSha, `HEAD matches the returned commit SHA`);

    const log = git("log --oneline -1", repoDir);
    assert(log.includes("Resolve merge conflicts"), `Commit log: ${log}`);

    // The resolution commit must descend from BOTH originals.
    let ancHead = false, ancBase = false;
    try { git(`merge-base --is-ancestor ${headBefore} HEAD`, repoDir); ancHead = true; } catch { /* not ancestor */ }
    try { git(`merge-base --is-ancestor base-branch HEAD`, repoDir); ancBase = true; } catch { /* not ancestor */ }
    assert(ancHead, `Resolution commit descends from PR head`);
    assert(ancBase, `Resolution commit descends from base-branch`);

    // Verify file contents in the user's working tree
    const config = readFileSync(join(repoDir, "config.ts"), "utf-8");
    assert(config.includes("1.5.0"), "config.ts has incoming version (1.5.0)");
    assert(!config.includes("<<<<<<<"), "config.ts has no conflict markers");

    const utils = readFileSync(join(repoDir, "utils.ts"), "utf-8");
    assert(utils.includes("Welcome back"), "utils.ts has baseline greeting");
    assert(!utils.includes("<<<<<<<"), "utils.ts has no conflict markers");
  } else {
    console.error(`  Error: ${(result as any).error || "unknown"}`);
  }
}

function testRefuseWrongBranch(): void {
  console.log("\n── Test 5b: refuses when checked out on the wrong branch ──");

  const tmpDir = createTestRepo();
  git(`remote add origin ${tmpDir}`, tmpDir);
  git("fetch origin", tmpDir);
  // Intentionally check out the BASE branch (the previously-buggy case).
  git("checkout base-branch", tmpDir);

  const resolutions = new Map<string, "baseline" | "incoming">();
  resolutions.set("config.ts", "incoming");
  resolutions.set("utils.ts", "baseline");

  const result = resolveConflicts({
    gitRoot: tmpDir,
    owner: "test",
    repo: "test",
    pullNumber: 100,
    token: "",
    base: "base-branch",
    head: "head-branch",
    resolutions,
  });

  assert(result.status === "aborted", `Status: ${result.status} (expected aborted)`);
  assert(!!result.error && result.error.includes("PR head"), `Error mentions PR head: ${result.error}`);

  // base-branch should be unchanged
  const baseStatus = git("status --porcelain", tmpDir);
  assert(baseStatus === "", `base-branch working tree unchanged after refusal`);

  rmSync(tmpDir, { recursive: true, force: true });
}

function testPartialResolve(): void {
  console.log("\n── Test 6: Partial resolve (one of two files) ──");

  // Create a fresh repo for this test
  const tmpDir = createTestRepo();
  git(`remote add origin ${tmpDir}`, tmpDir);
  git("fetch origin", tmpDir);
  git("checkout head-branch", tmpDir);

  const resolutions = new Map<string, "baseline" | "incoming">();
  resolutions.set("config.ts", "baseline");
  // Intentionally leave utils.ts unresolved

  const result = resolveConflicts({
    gitRoot: tmpDir,
    owner: "test",
    repo: "test",
    pullNumber: 42,
    token: "",
    base: "base-branch",
    head: "head-branch",
    resolutions,
  });

  assert(result.status === "partial", `Resolve result: ${result.status} (expected partial)`);
  if (result.status === "partial") {
    assert(result.resolved!.length === 1, `Resolved ${result.resolved!.length} file(s)`);
    assert(result.skipped!.length === 1, `Skipped ${result.skipped!.length} file(s)`);
    assert(result.skipped![0] === "utils.ts", `Skipped file: ${result.skipped![0]}`);
  }

  // Merge should be left in progress (MERGE_HEAD present) so user can finish
  let mergeInProgress = false;
  try { git("rev-parse -q --verify MERGE_HEAD", tmpDir); mergeInProgress = true; } catch { /* no merge */ }
  assert(mergeInProgress, `Merge is left in progress for the user to finish`);

  // utils.ts should still have conflict markers (unresolved)
  // config.ts should be staged with the chosen side
  const lsFiles = git("ls-files -u utils.ts", tmpDir);
  assert(lsFiles.length > 0, `utils.ts still has unmerged stages`);

  // Clean up
  try { git("merge --abort", tmpDir); } catch { /* fine */ }
  rmSync(tmpDir, { recursive: true, force: true });
}

function testDeletionResolution(): void {
  console.log("\n── Test 8: modify/delete conflict resolves via git rm ──");

  const tmpDir = mkdtempSync(join(tmpdir(), "pr-del-conflict-"));
  git("init -b main", tmpDir);
  git('config user.email "test@test.com"', tmpDir);
  git('config user.name "Test"', tmpDir);

  writeFileSync(join(tmpDir, "doomed.txt"), "original line\n");
  git("add -A", tmpDir);
  git('commit -m "init"', tmpDir);

  // Base: modify the file
  git("checkout -b base-branch", tmpDir);
  writeFileSync(join(tmpDir, "doomed.txt"), "base modified line\n");
  git("add -A", tmpDir);
  git('commit -m "base modifies doomed.txt"', tmpDir);

  // Head: delete the file
  git("checkout main", tmpDir);
  git("checkout -b head-branch", tmpDir);
  execSync("rm doomed.txt", { cwd: tmpDir });
  git("add -A", tmpDir);
  git('commit -m "head deletes doomed.txt"', tmpDir);

  git(`remote add origin ${tmpDir}`, tmpDir);
  git("fetch origin", tmpDir);
  // Must be on head-branch for resolution to land on the right branch
  git("checkout head-branch", tmpDir);

  // Pick "incoming" (PR head) which deleted the file — must produce a deletion
  const resolutions = new Map<string, "baseline" | "incoming">();
  resolutions.set("doomed.txt", "incoming");

  const result = resolveConflicts({
    gitRoot: tmpDir,
    owner: "test",
    repo: "test",
    pullNumber: 13,
    token: "",
    base: "base-branch",
    head: "head-branch",
    resolutions,
  });

  assert(result.status === "committed", `Deletion resolve status: ${result.status}`);
  if (result.status === "committed") {
    // The resulting commit (HEAD) should not contain doomed.txt
    const tree = git(`ls-tree -r --name-only HEAD`, tmpDir);
    assert(!tree.split("\n").includes("doomed.txt"), `doomed.txt absent from resolution commit`);
  }

  rmSync(tmpDir, { recursive: true, force: true });
}

function testContextOverlap(): void {
  console.log("\n── Test 7: Context window doesn't overlap adjacent conflicts ──");

  // Create a repo where two conflicts are only 2 lines apart
  const tmpDir = mkdtempSync(join(tmpdir(), "pr-ctx-overlap-"));
  git("init -b main", tmpDir);
  git('config user.email "test@test.com"', tmpDir);
  git('config user.name "Test"', tmpDir);

  // Create initial file with two sections separated by a 4-line gap.
  // Git needs ~3+ unchanged lines between changes to keep them as separate hunks.
  const initial = [
    "line1", "line2", "line3", "line4", "line5",
    "section_a_value = original",
    "gap1", "gap2", "gap3", "gap4",
    "section_b_value = original",
    "line12", "line13", "line14", "line15", "line16",
  ].join("\n") + "\n";
  writeFileSync(join(tmpDir, "app.conf"), initial);
  git("add -A", tmpDir);
  git('commit -m "init"', tmpDir);

  // Base changes
  git("checkout -b base-branch", tmpDir);
  const baseContent = initial.replace("section_a_value = original", "section_a_value = base_version")
                             .replace("section_b_value = original", "section_b_value = base_version");
  writeFileSync(join(tmpDir, "app.conf"), baseContent);
  git("add -A", tmpDir);
  git('commit -m "base"', tmpDir);

  // Head changes (from main)
  git("checkout main", tmpDir);
  git("checkout -b head-branch", tmpDir);
  const headContent = initial.replace("section_a_value = original", "section_a_value = head_version")
                             .replace("section_b_value = original", "section_b_value = head_version");
  writeFileSync(join(tmpDir, "app.conf"), headContent);
  git("add -A", tmpDir);
  git('commit -m "head"', tmpDir);

  git("checkout main", tmpDir);
  git(`remote add origin ${tmpDir}`, tmpDir);
  git("fetch origin", tmpDir);

  const conflicts = extractConflicts(tmpDir, "base-branch", "head-branch");
  const appConf = conflicts.find(c => c.path === "app.conf");

  assert(appConf !== undefined, "app.conf has conflicts");
  if (appConf) {
    assert(appConf.regions.length === 2, `app.conf has ${appConf.regions.length} regions (expected 2)`);

    if (appConf.regions.length === 2) {
      const r0 = appConf.regions[0];
      const r1 = appConf.regions[1];

      // Context after region 0 should NOT contain conflict markers from region 1
      const r0AfterHasMarkers = r0.contextAfter.some(l => l.startsWith("<<<<<<<") || l.startsWith(">>>>>>>") || l.startsWith("======="));
      assert(!r0AfterHasMarkers, "Region 0 contextAfter has no conflict markers from region 1");

      // Context before region 1 should NOT contain conflict markers from region 0
      const r1BeforeHasMarkers = r1.contextBefore.some(l => l.startsWith("<<<<<<<") || l.startsWith(">>>>>>>") || l.startsWith("======="));
      assert(!r1BeforeHasMarkers, "Region 1 contextBefore has no conflict markers from region 0");

      // Context should be clamped: region 0's contextAfter should end at or before region 1's start
      assert(r0.contextAfter.length <= 4, `Region 0 contextAfter length: ${r0.contextAfter.length} (expected ≤ 4 — gap is only 4 lines)`);
      assert(r1.contextBefore.length <= 4, `Region 1 contextBefore length: ${r1.contextBefore.length} (expected ≤ 4 — gap is only 4 lines)`);
    }
  }

  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── Run ────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log("╔═══════════════════════════════════════════╗");
  console.log("║  Conflict Detection & Resolution Tests   ║");
  console.log("╚═══════════════════════════════════════════╝");

  const repoDir = createTestRepo();
  console.log(`Test repo: ${repoDir}`);

  try {
    testExtractConflicts(repoDir);
    testValidateAndResolve(repoDir);
    testBadResolution(repoDir);
    testTypoDetection(repoDir);
    testFullResolve(repoDir);
    testRefuseWrongBranch();
    testPartialResolve();
    testContextOverlap();
    testDeletionResolution();
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(`\n═════════════════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
