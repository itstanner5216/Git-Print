/**
 * test-render-fixture.mjs
 *
 * Fixture test for renderPR(). Builds a PRData object mirroring the canonical
 * example (PR #20 — the tree-sitter DEF_TYPES PR), renders it, and asserts the
 * output matches the PR-page-as-markdown contract:
 *
 *   - One flat "Comment N" flow in scroll order — no backend buckets
 *     (Goals §4, Constraints §2/§3/§4).
 *   - Markdown, not UI furniture: no action buttons, no tab bars, no reply
 *     boxes (Constraints §9).
 *   - Inline threads keep the GitHub UI stack: reviewer + timestamp +
 *     severity, file path + line anchor, line-numbered code context,
 *     comment prose, numbered suggested changesets with @@ headers.
 *   - Comment prose is byte-faithful — never escaped or reflowed.
 *   - Bot promo/footer lines are dropped; whole comments that are nothing
 *     but promotion are skipped without consuming a Comment number.
 *
 * Run:  node test-render-fixture.mjs   (after `pnpm build`)
 */

import { renderPR } from "../dist/pr-renderer.js";
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
  "",
  "Copilot uses AI. Check for mistakes.",
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
  "",
  "Copilot uses AI. Check for mistakes.",
].join("\n");

// An issue comment thick with web→markdown debris — exercises the cleaning
// policy inside the real render path.
const noisyIssueCommentBody = [
  "<!-- coderabbit metadata -->",
  "Check [the migration guide](https://docs.example.com/guide) before merging — also see <https://auto.generated.link/from/translation>.",
  "",
  "![badge](https://img.shields.io/badge/coverage-98%25-green.svg)",
  "",
  "The `config_loader.ts` parser uses snake_case_keys and array[0] access.",
  "",
  "[Share on Twitter](https://twitter.com/intent/tweet?text=hi)",
  "Thanks for using CodeRabbit! It's free for OSS.",
].join("\n");

// A comment that is NOTHING but promotion — must be skipped entirely.
const promoOnlyCommentBody = [
  "Thanks for using CodeRabbit! It's free for OSS.",
  "[Share on Twitter](https://twitter.com/intent/tweet?text=love)",
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
  issueComments: [
    {
      id: 201,
      body: noisyIssueCommentBody,
      user: { login: "coderabbitai", type: "Bot" },
      created_at: "2026-06-07T10:01:00Z",
      author_association: "NONE",
    },
    {
      id: 202,
      body: promoOnlyCommentBody,
      user: { login: "coderabbitai", type: "Bot" },
      created_at: "2026-06-07T10:02:00Z",
      author_association: "NONE",
    },
  ],
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

const outPath = join(tmpdir(), `pr20-fixture-${Date.now()}.md`);
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

// ── Header: title, status line, counters ──
check("h1 title", has("# PR #20 — feat(tree-sitter): export DEF_TYPES + regression test for definition node coverage"));
check("status line", has("**Open** · itstanner5216 wants to merge 4 commits into `main` from `feat/def-types-coverage`"));
// Conversation count mirrors the GitHub page number — the promo-only comment
// exists on the page (we just don't print it), so it counts: 2 issue comments
// + 2 review comments + 1 review with body = 5.
check("counters line", has("Conversation 5 · Commits 4 · Checks 7 · Files changed 3 · `+73` `−0`"));

// ── PR description as post body (directly under title, unlabeled) ──
check("description present", has("Exports the DEF_TYPES constant from the tree-sitter symbols module"));
check("description before sidebar", idx("Exports the DEF_TYPES") < idx("**Reviewers:**"));

// ── Sidebar metadata ──
check("reviewers", has("- **Reviewers:** Copilot, coderabbitai [Bot]"));
check("assignees", has("- **Assignees:** No one"));
check("labels", has("- **Labels:** None"));
check("milestone", has("- **Milestone:** None"));

// ── One flat Comments flow, numbered in scroll order ──
check("comments heading", has("## Comments"));
check("comment 1", has("### Comment #1"));
check("comment 2", has("### Comment #2"));
check("comment 3", has("### Comment #3"));
check("comment 4", has("### Comment #4"));
const commentHeaders = (out.match(/^### Comment #\d+$/gm) || []).length;
check("exactly 4 numbered comments (promo-only comment skipped)", commentHeaders === 4);
check("ordering c1<c2<c3<c4",
  idx("### Comment #1") < idx("### Comment #2") &&
  idx("### Comment #2") < idx("### Comment #3") &&
  idx("### Comment #3") < idx("### Comment #4"));

// ── No backend buckets, no UI furniture (Constraints §3, §9) ──
check("no Reviews section", !/^#{1,6}\s+Reviews\b/m.test(out));
check("no Inline Comments section", !/^#{1,6}\s+Inline\b/mi.test(out));
check("no Suggestions section", !/^#{1,6}\s+Suggestions\b/m.test(out));
check("no Timeline section", !/^#{1,6}\s+Timeline\b/mi.test(out));
check("no Bot Findings section", !/^#{1,6}\s+Bot/mi.test(out));
check("no action buttons", !has("[Commit suggestion]") && !has("[Resolve conversation]") && !has("[Reply]"));
check("no tab bar", !has("Tabs:"));
check("no raw verdict enum", !has("CHANGES_REQUESTED"));

// ── Comment 1: review event with verdict verb ──
check("review verdict verb", has("**coderabbitai [Bot]** requested changes · 2026-06-07 10:00:00 UTC"));
check("review body kept", has("Actionable comments were posted on this review."));
check("View reviewed changes dropped", !has("View reviewed changes"));

// ── Comment 2 (thread 1): UI stack — header w/ severity, file+anchor, numbered context, prose, changeset ──
check("t1 header has severity", has("**Copilot [AI]** reviewed · 2026-06-07 10:00:00 UTC · Severity: Medium"));
check("t1 file+anchor", has("`packages/zenith-mcp/tests/def-types-coverage.test.js` — lines +155 to +158"));
check("t1 numbered context 155", has("155 + if (c !== '(' && c !== '[') { i++; continue; }"));
check("t1 numbered context 158", has("158 + // include trailing quantifier + capture in the pattern text we"));
check("t1 prose byte-faithful", has("extractDefinitionNodeTypes() currently breaks on an unmatched delimiter because findMatchingClose() returns -1."));
check("t1 severity line not duplicated in body", !/^Severity: Medium$/m.test(out));
check("t1 changeset header with path", has("**Suggested changeset 1:** `packages/zenith-mcp/tests/def-types-coverage.test.js`"));
check("t1 @@ header with heading", /@@ -\d+,\d+ \+\d+,\d+ @@ function extractDefinitionNodeTypes\(scmText\) \{/.test(out));
check("t1 removed line", has("-if (end === -1) break;"));
check("t1 added throw", has("+  throw new Error(`Malformed tree-sitter query: unmatched ${c} at offset ${i}`);"));
check("t1 unchanged line is context not removal", !has("-if (c !== '(' && c !== '[')"));
check("t1 Copilot footer dropped", !has("Copilot uses AI"));

// ── Comment 3 (thread 2): single-line anchor + one-line swap ──
check("t2 header has severity low", has("**Copilot [AI]** reviewed · 2026-06-07 10:00:01 UTC · Severity: Low"));
check("t2 file+anchor", has("`packages/zenith-mcp/src/core/tree-sitter/symbols.ts` — line +68"));
check("t2 numbered context 65", has("65 + // ----------------------------------------------------------"));
check("t2 numbered context 68", has("68 +   // XML/HTML element-shape patterns (camelCase upstream node names)"));
check("t2 removed camelCase", has("-  // XML/HTML element-shape patterns (camelCase upstream node names)"));
check("t2 added PascalCase", has("+  // XML/HTML element-shape patterns (PascalCase upstream node names)"));

// ── Comment 4 (noisy issue comment): debris policy in the render path ──
check("c4 link text kept", has("Check the migration guide before merging"));
check("c4 link target gone", !has("docs.example.com/guide"));
check("c4 angle autolink gone", !has("auto.generated.link"));
check("c4 image gone", !has("img.shields.io"));
check("c4 prose identifiers byte-faithful", has("The `config_loader.ts` parser uses snake_case_keys and array[0] access."));
check("c4 no escape mangling", !has("snake\\_case") && !has("array\\[0]"));
check("c4 share line dropped", !has("Share on Twitter"));
check("c4 thanks line dropped", !has("Thanks for using CodeRabbit"));

// ── Resolved: section absent when no resolved threads exist (Goals §6) ──
check("no Resolved section", !has("## Resolved"));

// ── Checks + merge status ──
check("checks heading", has("## Checks"));
check("checks summary", has("4 successful · 3 in progress · 0 failed"));
check("check in progress", has("- ◷ CodeQL Advanced / Analyze (javascript-typescript) (pull_request) — In progress"));
check("check skipped", has("- ✓ CodeRabbit Review — Skipped"));
check("check duration", has("- ✓ GitGuardian Security Checks — Successful in 1s"));
check("merge blocked with reasons", has("**Merging is blocked** — 1 change requested, 3 checks in progress."));

// ── Markdown quality: no triple blank lines, single H1 ──
check("no triple newlines outside fences",
  out.split(/```[\s\S]*?```/g).every((seg) => !seg.includes("\n\n\n")));
check("single H1", (out.match(/^# /gm) || []).length === 1);

// ─── Report ───────────────────────────────────────────────────────────────────

const total = failures.length;
if (total === 0) {
  console.log(`PASS — all assertions passed (${out.length} bytes rendered).`);
  process.exit(0);
} else {
  console.error(`FAIL — ${total} assertion(s) failed:`);
  for (const f of failures) console.error("  ✗ " + f);
  console.error("\n----- rendered output -----\n");
  console.error(out);
  process.exit(1);
}
