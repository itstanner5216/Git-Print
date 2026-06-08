/**
 * test-render-fixture.mjs
 *
 * Fixture test for renderPR(). Builds a PRData object mirroring the canonical
 * example (PR #20 — the tree-sitter DEF_TYPES PR), renders it, and asserts the
 * output matches the example's structure: flat "Comment N" cards, line-numbered
 * code context, and CLEAN unified-diff suggestion blocks (the bug this fixes).
 *
 * Run:  node test-render-fixture.mjs   (after `npm run build`)
 */

import { renderPR } from "./dist/pr-renderer.js";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Fixture data (mirrors example_renderer.md / PR #20) ──────────────────────

const sha = (p) => (p + "0".repeat(40)).slice(0, 40);

const thread1Hunk = [
  "@@ -150,3 +152,7 @@ function extractDefinitionNodeTypes(scmText) {",
  " const text = scmText;",
  " const n = text.length;",
  " let i = 0;",
  "+if (c !== '(' && c !== '[') { i++; continue; }",
  "+const end = findMatchingClose(text, i);",
  "+if (end === -1) break;",
  "+// include trailing quantifier + capture in the pattern text we",
].join("\n");

const thread1Body = [
  "extractDefinitionNodeTypes() currently breaks on an unmatched delimiter because findMatchingClose() returns -1.",
  "That can silently turn a malformed tags query into a partial scan and potentially a false-positive test pass.",
  "Since this file is a regression guard, it should fail loudly when the scanner cannot parse the input.",
  "",
  "Severity: Medium",
  "",
  "```suggestion",
  "if (c !== '(' && c !== '[') { i++; continue; }",
  "const end = findMatchingClose(text, i);",
  "if (end === -1) {",
  "  throw new Error(`Malformed tree-sitter query: unmatched ${c} at offset ${i}`);",
  "}",
  "// include trailing quantifier + capture in the pattern text we",
  "```",
].join("\n");

const thread2Hunk = [
  "@@ -62,0 +65,4 @@",
  "+// ----------------------------------------------------------",
  "+",
  "+export const DEF_TYPES: ReadonlySet = new Set([",
  "+  // XML/HTML element-shape patterns (camelCase upstream node names)",
].join("\n");

const thread2Body = [
  "The comment says these XML/HTML node types are \"camelCase\", but the examples ('Attribute', 'EmptyElemTag', 'STag') are PascalCase.",
  "This can confuse future readers about the intended ordering and format of these upstream node type names.",
  "",
  "Severity: Low",
  "",
  "```suggestion",
  "  // XML/HTML element-shape patterns (PascalCase upstream node names)",
  "```",
].join("\n");

const data = {
  pr: {
    number: 20,
    title: "feat(tree-sitter): export DEF_TYPES + regression test for definition node coverage",
    state: "open",
    body: "Exports the DEF_TYPES constant from the tree-sitter symbols module and adds a regression test to guard definition node coverage.",
    author_association: "OWNER",
    created_at: "2026-06-07T09:00:00Z",
    updated_at: "2026-06-07T10:05:00Z",
    merged: false,
    merged_at: null,
    merged_by: null,
    user: { login: "itstanner5216", type: "User" },
    base: { ref: "main", sha: sha("main"), label: "main" },
    head: { ref: "feat/def-types-coverage", sha: sha("head"), label: "feat" },
    mergeable: false,
    mergeable_state: "blocked",
    changed_files: 3,
    additions: 73,
    deletions: 0,
    requested_reviewers: [
      { login: "Copilot", type: "Bot" },
      { login: "coderabbitai", type: "Bot" },
    ],
    assignees: [],
    labels: [],
    milestone: null,
  },
  commits: [
    { sha: sha("e3e6e22") },
    { sha: sha("6ed1f2b") },
    { sha: sha("abc1234") },
    { sha: sha("def5678") },
  ],
  files: [],
  checkRuns: [],
  statuses: [],
  reviews: [
    {
      user: { login: "coderabbitai", type: "Bot" },
      state: "CHANGES_REQUESTED",
      body: "Actionable comments were posted on this review.\nView reviewed changes >",
      submitted_at: "2026-06-07T10:00:00Z",
      author_association: "NONE",
    },
  ],
  reviewComments: [
    {
      id: 101,
      in_reply_to_id: null,
      path: "packages/zenith-mcp/tests/def-types-coverage.test.js",
      start_line: 155,
      line: 158,
      original_start_line: 155,
      original_line: 158,
      diff_hunk: thread1Hunk,
      body: thread1Body,
      user: { login: "Copilot", type: "Bot" },
      created_at: "2026-06-07T10:00:00Z",
      author_association: "NONE",
    },
    {
      id: 102,
      in_reply_to_id: null,
      path: "packages/zenith-mcp/src/core/tree-sitter/symbols.ts",
      start_line: null,
      line: 68,
      original_start_line: null,
      original_line: 68,
      diff_hunk: thread2Hunk,
      body: thread2Body,
      user: { login: "Copilot", type: "Bot" },
      created_at: "2026-06-07T10:00:01Z",
      author_association: "NONE",
    },
  ],
  issueComments: [],
  resolvedThreadMap: null,
  unifiedChecks: [
    { name: "CodeQL Advanced / Analyze (javascript-typescript) (pull_request)", status: "in_progress", conclusion: null, startedAt: "2026-06-07T10:00:00Z", completedAt: null, detailsUrl: null, description: "Code scanning is waiting for results on commits e3e6e22 or 6ed1f2b.", checkRunId: 1, source: "check_run" },
    { name: "cubic · AI code reviewer", status: "in_progress", conclusion: null, startedAt: "2026-06-07T10:00:00Z", completedAt: null, detailsUrl: null, description: "Reviewed 0 of 2 files · 0%", checkRunId: 2, source: "check_run" },
    { name: "semgrep-cloud-platform/scan", status: "in_progress", conclusion: null, startedAt: "2026-06-07T10:00:00Z", completedAt: null, detailsUrl: null, description: "This check has started.", checkRunId: 3, source: "check_run" },
    { name: "CodeRabbit Review", status: "completed", conclusion: "skipped", startedAt: null, completedAt: null, detailsUrl: null, description: null, checkRunId: 4, source: "check_run" },
    { name: "GitGuardian Security Checks", status: "completed", conclusion: "success", startedAt: "2026-06-07T10:00:00Z", completedAt: "2026-06-07T10:00:01Z", detailsUrl: null, description: "No secrets detected", checkRunId: 5, source: "check_run" },
    { name: "Socket Security: Project Report", status: "completed", conclusion: "success", startedAt: "2026-06-07T10:00:00Z", completedAt: "2026-06-07T10:00:06Z", detailsUrl: null, description: "Project Report: Success", checkRunId: 6, source: "check_run" },
    { name: "Build", status: "completed", conclusion: "success", startedAt: null, completedAt: null, detailsUrl: null, description: "Details not visible in current screenshot/API payload", checkRunId: 7, source: "check_run" },
  ],
  rateLimitState: { remaining: 5000, resetAt: 0 },
};

// ─── Run renderer ─────────────────────────────────────────────────────────────

const outPath = join(tmpdir(), `pr20-fixture-${Date.now()}.txt`);
await renderPR(data, {
  owner: "itstanner5216",
  repo: "zenith",
  pullNumber: 20,
  token: "dummy",
  outputPath: outPath,
});
const out = await readFile(outPath, "utf-8");
await unlink(outPath).catch(() => {});

// ─── Assertions ───────────────────────────────────────────────────────────────

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); };
const idx = (s) => out.indexOf(s);
const has = (s) => out.includes(s);

// Header
check("starts with double rule", out.startsWith("═"));
check("title line", has("PR #20 — feat(tree-sitter): export DEF_TYPES + regression test for definition node coverage"));
check("state line one-liner", has("[Open] itstanner5216 wants to merge 4 commits into main from feat/def-types-coverage"));
check("tabs line", has("Tabs: Conversation 3 | Commits 4 | Checks 7 | Files changed 3"));
check("branches line", has("Branches: feat/def-types-coverage → main"));
check("commits line", has("e3e6e22, 6ed1f2b") && has("(4 total)"));
check("stats line", has("Stats: +73 / -0"));

// PR information (inline Label: value)
check("reviewers inline", has("Reviewers: Copilot, coderabbitai [Bot]"));
check("assignees inline", has("Assignees: No one"));
check("labels inline", has("Labels: None"));
check("projects inline", has("Projects: None"));
check("milestone inline", has("Milestone: None"));

// Flat Comment N numbering, no sub-headers
check("comment 1", has("COMMENT 1"));
check("comment 2", has("COMMENT 2"));
check("comment 3", has("COMMENT 3"));
check("comment 4", has("COMMENT 4"));
check("no 5th comment", !has("COMMENT 5"));
check("no INLINE THREAD subheaders", !has("INLINE THREAD"));
check("no markdown subheaders", !/^#{1,6}\s/m.test(out));
const commentHeaders = (out.match(/^COMMENT \d+$/gm) || []).length;
check("exactly 4 comment cards", commentHeaders === 4);

// Card ordering: description < review < thread1 < thread2
check("order c1<c2", idx("COMMENT 1") < idx("COMMENT 2"));
check("order c2<c3", idx("COMMENT 2") < idx("COMMENT 3"));
check("order c3<c4", idx("COMMENT 3") < idx("COMMENT 4"));
check("description is comment 1", idx("itstanner5216 commented — Owner") > idx("COMMENT 1") && idx("itstanner5216 commented — Owner") < idx("COMMENT 2"));
check("review is comment 2", idx("coderabbitai [Bot] requested changes") > idx("COMMENT 2") && idx("coderabbitai [Bot] requested changes") < idx("COMMENT 3"));
check("review verb 'requested changes' (not raw state)", has("requested changes") && !has("CHANGES_REQUESTED"));
check("thread1 is comment 3", idx("File: packages/zenith-mcp/tests/def-types-coverage.test.js") > idx("COMMENT 3") && idx("File: packages/zenith-mcp/tests/def-types-coverage.test.js") < idx("COMMENT 4"));
check("thread2 is comment 4", idx("File: packages/zenith-mcp/src/core/tree-sitter/symbols.ts") > idx("COMMENT 4"));

// Inline thread 1 — identity + line-numbered code context
check("t1 anchor multi-line", has("Anchor: Comment on lines +155 to +158"));
check("t1 thread status open", has("Thread status: Open"));
check("t1 code context header", has("Code context:"));
check("t1 numbered context 155", has("  155 + if (c !== '(' && c !== '[') { i++; continue; }"));
check("t1 numbered context 158", has("  158 + // include trailing quantifier + capture in the pattern text we"));
check("t1 reviewer line [AI] + severity", /Reviewer: Copilot \[AI\] \| .* \| Severity: Medium/.test(out));

// Inline thread 1 — CLEAN suggestion diff (THE BUG FIX)
check("t1 suggested changeset header", has("Suggested changeset 1:"));
check("t1 recomputed @@ header", /  @@ -\d+,\d+ \+\d+,\d+ @@ function extractDefinitionNodeTypes/.test(out));
check("t1 removed line is the break", has("  -if (end === -1) break;"));
check("t1 added throw block", has("  +if (end === -1) {") && has("  +}"));
// The unchanged lines must be CONTEXT, never marked as removed (the old bug
// dumped every original line with a '-' prefix):
check("t1 unchanged line not marked removed", !has("-if (c !== '(' && c !== '[')"));
check("t1 unchanged line not marked removed (findMatchingClose)", !has("-const end = findMatchingClose(text, i);"));

// Inline thread 2 — single-line anchor + clean one-line swap
check("t2 anchor single line", has("Anchor: Comment on line +68"));
check("t2 numbered context 65", has("  65 + // ----------------------------------------------------------"));
check("t2 numbered context 68 camelCase", has("  68 +   // XML/HTML element-shape patterns (camelCase upstream node names)"));
check("t2 reviewer severity low", /Reviewer: Copilot \[AI\] \| .* \| Severity: Low/.test(out));
check("t2 removed camelCase", has("-  // XML/HTML element-shape patterns (camelCase upstream node names)"));
check("t2 added PascalCase", has("+  // XML/HTML element-shape patterns (PascalCase upstream node names)"));

// Anti raw-dump: only the 2 recomputed suggestion @@ headers should appear.
const atCount = (out.match(/@@ -\d+/g) || []).length;
check("exactly 2 @@ headers (no raw diff_hunk dump)", atCount === 2);

// Actions line (single line, indented)
check("t1 actions line", has("  [Commit suggestion] [Add suggestion to batch] [Reply] [Resolve conversation]"));

// CHANGES REVIEWED (indented counts)
check("changes reviewed header", has("CHANGES REVIEWED"));
check("changes requested sentence", has("1 change requested by reviewers with write access."));
check("changes requested indented mark", has("  ✕ 1 requested change"));

// CI / CHECKS (indented, inline None)
check("ci header", has("CI / CHECKS"));
check("ci status line", has("Some checks have not completed yet."));
check("ci summary in progress", has("  3 in progress"));
check("ci summary successful", has("  4 successful"));
check("ci summary failed", has("  0 failed"));
check("ci in-progress entry", has("  ◷ CodeQL Advanced / Analyze (javascript-typescript) (pull_request)"));
check("ci in-progress detail", has("    Code scanning is waiting for results on commits e3e6e22 or 6ed1f2b."));
check("ci successful entry", has("  ✓ GitGuardian Security Checks"));
check("ci successful duration", has("    Successful in 1s"));
check("ci successful detail", has("    No secrets detected"));
check("ci socket 6s", has("    Successful in 6s"));
check("ci failed none inline", has("Failed: None"));

// MERGE AREA (indented reasons)
check("merge header", has("MERGE AREA"));
check("merge blocked", has("Merging is blocked."));
check("merge reasons header", has("Reasons:"));
check("merge reason change requested indented", has("  1 change requested by reviewers with write access"));
check("merge reason checks in progress indented", has("  3 checks still in progress"));
check("merge button disabled", has("[Merge pull request] disabled"));

// ─── Report ───────────────────────────────────────────────────────────────────

const total = failures.length;
if (total === 0) {
  console.log(`PASS — all assertions passed (${out.length} bytes rendered).`);
  console.log("\n----- rendered output -----\n");
  console.log(out);
  process.exit(0);
} else {
  console.error(`FAIL — ${total} assertion(s) failed:`);
  for (const f of failures) console.error("  ✗ " + f);
  console.error("\n----- rendered output -----\n");
  console.error(out);
  process.exit(1);
}
