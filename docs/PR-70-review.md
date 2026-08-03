# PR #70 — Add edit tool: original-relative line edits, forgiving matching, snapshot undo net

**Open** · itstanner5216 wants to merge 6 commits into `main` from `worktree-edit-tool`

Conversation 48 · Commits 6 · Checks 14 · Files changed 6 · `+2005` `−8`

## What

A brand-new, single `edit` tool (`packages/zenith-mcp/src/tools/edit.ts`) built to replace `edit_file` + `core/edit-engine.ts`. The old tool stays registered untouched until this one is proven; nothing from it is imported or reused.

## Design

**Two shapes, no `mode` param** — inferred from populated fields:
- **Line-range replace** (primary): `startLine`/`endLine` (1-based inclusive) + `newContent`. The numbers are the target — no content matching.
- **Content replace**: `oldContent` + `newContent` (field deliberately named `oldContent`, not `oldText`/`oldString`).
- Complete range wins; `oldContent` is fallback evidence that can never fail a valid range edit; out-of-bounds range falls back to a matchable `oldContent` before failing; neither → `Specify a line range or oldContent.`

**Original-relative coordinates by construction.** Every edit resolves to a character-span claim over the *original* content; claims can't overlap (a later overlapping edit fails alone, naming the earlier one); the file is rebuilt in one sorted pass. There is no shift ledger to drift — the old tool's #1 bug class is structurally impossible.

**Forgiveness that never mis-targets.** Content matching is pure string ops (no needle is ever a pattern), claim-aware (duplicate `oldContent`s progress through the file in edit order), three tiers: exact → trailing-whitespace-tolerant → uniform-indent-shift. Nearest shift wins; two distinct equidistant shifts refuse to guess. `newContent` is re-indented to the target's base using the file's verbatim whitespace (tabs stay tabs); non-uniformly-shiftable content is applied untouched, never altered.

**Don't-fail.** Writes are never gated on syntax; breakage is applied and reported. Hard failures only: missing/unwritable file, out-of-bounds range, unmatchable `oldContent` — one short line each. A failing edit never blocks the rest of the call; per-file atomicity for multi-file batches (per-edit `path` override).

**Patch snapshots (undo/reuse net).** Every write is preceded by **one snapshot per applied edit holding the literal patch**: `original_text` = the exact replaced span, `new_text` = the exact replacement as applied (post re-indent), `line` = the original start line. Stored in the existing `versions` table (new `new_text` column, tolerant migration) keyed `file://<relPath>` per session/file via new `snapshotEdit`/`snapshotEditVersion` + `getVersionPatch` — no new persistence layer. A patch maps back after later edits shift line numbers (undo reverses by content), shows exactly what changed, and the cached `oldText→newText` pair is re-appliable anywhere in the repo without restating `newText`. Retention: 10 newest per session/file; `text_hash` fingerprints both sides (length-prefixed framing) so only identical patches dedup, refreshing their recency. Snapshot/index failures never fail an edit.

**Filesystem.** Atomic temp→chmod→rename preserving the exact original mode (chmod, not umask-masked `writeFile` mode), best-effort chown, guaranteed temp cleanup on every failure path, BOM preserved, dominant EOL preserved (CRLF stays CRLF; lone-`\r` treated as a real line boundary).

**Return contract (7:1 lesson).** Verbatim strings, nothing else — no counts, paths, or summaries:
- clean parse ran: `Edit applied sucessfully, no parsing errors detected.`
- breakage: `Edit applied sucessfully. A parsing error was detected at line N, <kind>.` (first error + the kind tree-sitter names; `checkSyntaxErrors` now returns `kind`)
- no parse could run (no grammar / suppressed dialect): `Edit applied sucessfully.` — no detection claim without a real detection.

## Testing

`tests/edit-tool.test.js` — 81 adversarial proofs asserting final file bytes, not just "no error": line-mapping exactness (grow/shrink/adjacent/reverse/overlap/content-below-growth), wrong-region negatives (equidistant-shift ambiguity refuses; exact-indent beats shifted), character safety (regex metachars, `$&`/`$1` replacement-pattern injection, quotes, unicode, payload-lookalikes), verbatim return strings incl. the no-`detected`-without-a-parse honesty check, mode 0600/0755 preservation, zero temp litter incl. an injected rename failure, CRLF/lone-CR/BOM, patch-snapshot exactness (old/new/line, re-indented `new_text` stored as applied, deletion patches, LF-normalized frame, cap-10 retention, dedup recency), multi-file per-file atomicity and only-edited-files-parsed.

- `pnpm build` clean; new suite 81/81 green.
- Full package suite: same 173 pre-existing failures as pristine main source with a freshly rebuilt dist (verified via stash + rebuild baseline) — all in TOON/compression/write-file territory, zero overlap with this PR's seams. Seam-adjacent suites (`core-server`, `edit-engine-*`, `edit-file-tool`, `db-adapter-v1-tables`, `refactor-batch`) all pass.
- Pre-existing (not addressed here): `dist` fails to load under plain `node` on main due to `js-yaml` v5 ESM default-export interop (`adapters/helpers/yaml.js`); vitest's interop masks it. Worth its own fix.

🤖 Generated with Claude Code

https://claude.ai/code/session_0121in9pKJrLVmiwdbc48QJu

> ### Add file edit tool with original-relative line edits, forgiving matching, and snapshot undo
> - Registers a new `edit` tool in edit.ts that applies one or more edits to one or more files per call, supporting both line-range and content-based replacements.
> - Line-range edits use original-file-relative line numbers across multiple edits in the same call; content matching uses a four-tier strategy (exact, trailing-whitespace-tolerant, re-indent-fit, and tab/space-agnostic) to find an unambiguous target.
> - Writes are atomic per file (temp write → chmod/chown → rename), preserving BOM, dominant EOL style, and file permissions including setgid bits; binary and non-UTF-8 files are refused.
> - Patches are snapshotted in the `versions` table via `snapshotEdit` with a 10-patch cap per session/file and are excluded from TTL pruning; `checkSyntaxErrors` is extended to report `MISSING` node kinds alongside `ERROR`.
> - Risk: the `versions` table gains a new `new_text` column via a guarded `ALTER TABLE` on init, which may fail silently on unexpected DB errors.

> Macroscope summarized 6a02833.

---

- **Reviewers:** gemini-code-assist [Bot], copilot-pull-request-reviewer[bot], macroscopeapp [Bot], claude [Bot], coderabbitai [Bot], qodo-code-review [Bot], cubic-dev-ai [Bot]
- **Assignees:** No one
- **Labels:** None
- **Projects:** None
- **Milestone:** None
- **Development:** No linked issues

---

### Comment #1

🤖 **gemini-code-assist [Bot]** reviewed · 2026-07-03 09:27:47 UTC

## Code Review

This pull request introduces a new `edit` tool to `zenith-mcp` that supports line-range and content-based replacements with atomic writes, automatic backups/snapshots, and syntax error checking. It also updates the database adapter and symbol index to support file-level snapshots, and enhances tree-sitter syntax error reporting to include the error kind. A comprehensive test suite is added for the new tool. Feedback was provided regarding a potential `TypeError` when calling `fs.chown` on non-POSIX platforms (like Windows) where `uid` and `gid` are undefined.

`packages/zenith-mcp/src/tools/edit.ts` — lines +576 to +578

```diff
434 +                 await fs.chmod(tempPath, fileMode);
435 +                 try {
436 +                     await fs.chown(tempPath, fileUid, fileGid);
437 +                 } catch { /* ownership is best-effort — never fail an edit over chown */ }
```

🤖 **gemini-code-assist [Bot]** · 2026-07-03 09:27:47 UTC

On non-POSIX platforms (such as Windows), `fs.Stats` properties `uid` and `gid` may be `undefined`. Passing `undefined` values to `fs.chown` will throw a `TypeError` because it expects numeric arguments. Although this call is wrapped in a `try/catch` block, throwing and catching a `TypeError` on every single file write on Windows is inefficient and can be avoided by checking their types first.

```typescript
                if (typeof fileUid === 'number' && typeof fileGid === 'number') {
                    try {
                        await fs.chown(tempPath, fileUid, fileGid);
                    } catch { /* ownership is best-effort — never fail an edit over chown */ }
                }
```

### Comment #2

🦾 **copilot-pull-request-reviewer [AI]** reviewed · 2026-07-03 09:29:49 UTC

## Pull request overview

This PR introduces a new `edit` tool in `zenith-mcp` intended to supersede the existing `edit_file` + edit engine by applying multiple edits against *original-file-relative* coordinates, adding forgiving (but non-guessing) content matching, and recording per-file pre-edit snapshots for future undo support.

**Changes:**
- Added a new `edit` tool implementation with original-relative range edits, tiered content matching, atomic writes (mode preservation), BOM/EOL preservation, and best-effort snapshot/index refresh.
- Added an extensive adversarial test suite validating final file bytes, failure isolation, snapshot retention/dedup, and return-string contracts.
- Extended `checkSyntaxErrors` to report `kind` and detect both `ERROR` and `MISSING` nodes; added file-level snapshot support to the versions table layer and registered the new tool in the server.

### Reviewed changes

Copilot reviewed 6 out of 6 changed files in this pull request and generated 4 comments.

---

💡 Add Copilot custom instructions for smarter, more guided reviews. Learn how to get started.

`packages/zenith-mcp/src/tools/edit.ts` — lines +168 to +174

```diff
168 +             // ── Honest unwritable hard-fail before any work is spent.
169 +             try {
170 +                 await fs.access(absPath, fs.constants.W_OK);
171 +             } catch {
172 +                 failures.push(`${fileTag}File not writable.`);
173 +                 continue;
174 +             }
```

🦾 **Copilot [AI]** · 2026-07-03 09:29:48 UTC

`fs` is imported from `fs/promises`, which does not expose `fs.constants` in Node. `await fs.access(absPath, fs.constants.W_OK)` will throw at runtime ("Cannot read properties of undefined") before you can return the intended "File not writable." message.

**Suggested changeset 1:** `packages/zenith-mcp/src/tools/edit.ts`
```diff
167
168               // ── Honest unwritable hard-fail before any work is spent.
169               try {
170 -                 await fs.access(absPath, fs.constants.W_OK);
170 +                 const fh = await fs.open(absPath, 'r+');
171 +                 await fh.close();
172               } catch {
173                   failures.push(`${fileTag}File not writable.`);
174                   continue;
```

`packages/zenith-mcp/src/tools/edit.ts` — lines +483 to +487 _(outdated)_

```diff
483 +                 out.push(`Edit applied sucessfully. A parsing error was detected at line ${firstParseError.line}, ${firstParseError.kind}.`);
484 +             } else if (anyUnparsed) {
485 +                 out.push('Edit applied sucessfully.');
486 +             } else {
487 +                 out.push('Edit applied sucessfully, no parsing errors detected.');
```

🦾 **Copilot [AI]** · 2026-07-03 09:29:49 UTC

User-facing output strings contain the misspelling "sucessfully" (also repeated in comments/tests). Since this is a new tool, it’s a good time to correct the spelling to "successfully" and update the corresponding test expectations/docs accordingly.

### Comment #3

🤖 **macroscopeapp [Bot]** reviewed · 2026-07-03 09:33:40 UTC

`packages/zenith-mcp/src/tools/edit.ts` — line +559

```diff
409 +             // never fail an edit.
410 +             const repoRoot = findRepoRoot(absPath);
411 +             let db: ReturnType<typeof getDb> | null = null;
412 +             if (repoRoot !== null) {
```

🤖 **macroscopeapp [Bot]** · 2026-07-03 09:33:39 UTC

🟡 **Medium** `tools/edit.ts:412`

When the edited file lives in a sandbox-allowed subdirectory of a Git repo whose root is outside the allowlist, `ctx.validatePath(repoRoot)` rejects the repo root even though `ctx.validatePath(absPath)` already approved the file. This sets `db = null`, so `snapshotFile(...)` and `ensureFreshFromContent(...)` are both skipped — the edit writes successfully, but the undo snapshot and symbol-index refresh silently stop working for that file. Consider not re-validating the repo root (the file was already validated) or skipping `validatePath` for the repo root lookup.

### Comment #4

🤖 **claude [Bot]** reviewed · 2026-07-03 18:58:09 UTC

## Claude Code Review

This repository is configured for manual code reviews. Comment `@claude review` to trigger a review and subscribe this PR to future pushes, or `@claude review once` for a one-time review.

Tip: disable this comment in your organization's Code Review settings.

### Comment #5

🧑 **itstanner5216** commented · 2026-07-03 18:58:35 UTC

@coderabbit.ai please review this pr

### Comment #6

🤖 **macroscopeapp [Bot]** commented · 2026-07-03 18:58:46 UTC

#### Approvability

**Verdict:** Needs human review

This PR introduces a significant new file editing tool with complex content matching logic, database schema changes, and new undo/snapshot infrastructure. Multiple unresolved review comments identify potential runtime errors and edge case bugs that warrant human verification before merging.

### Comment #7

🤖 **coderabbitai [Bot]** commented · 2026-07-03 18:58:47 UTC

`@itstanner5216` Sure, I'll review this PR now and share detailed feedback shortly.

### Comment #8

🧑 **itstanner5216** commented · 2026-07-03 19:00:01 UTC

@ claude review once

### Comment #9

🦾 **copilot-pull-request-reviewer [AI]** reviewed · 2026-07-03 19:04:02 UTC

## Pull request overview

Copilot reviewed 6 out of 6 changed files in this pull request and generated 2 comments.

`packages/zenith-mcp/src/tools/edit.ts` — lines +231 to +232 _(outdated)_

```diff
229 +                     const s = Math.max(1, Math.min(spec.startLine, spec.endLine));
230 +                     const eRaw = Math.max(spec.startLine, spec.endLine);
231 +                     if (s <= lineCount) {
232 +                         const e = Math.min(Math.max(eRaw, s), lineCount);
```

🦾 **Copilot [AI]** · 2026-07-03 19:04:02 UTC

When the file ends with a trailing newline, `content.split('\n')` produces a synthetic final empty line. Using `lineCount` for line-range bounds/clamping lets an overshooting `endLine` clamp to that synthetic line, which can unintentionally consume the file’s final newline (and also treats `startLine == lineCount` as in-bounds even though it targets the synthetic line). Clamp/validate against an effective line count that excludes the terminal empty line when `content.endsWith('\n')`.

**Suggested changeset 1:** `packages/zenith-mcp/src/tools/edit.ts`
```diff
228                       // Swapped or off-the-front ranges are obvious intent — take them.
229                       const s = Math.max(1, Math.min(spec.startLine, spec.endLine));
230                       const eRaw = Math.max(spec.startLine, spec.endLine);
231 -                     if (s <= lineCount) {
232 -                         const e = Math.min(Math.max(eRaw, s), lineCount);
231 + const maxLine = (content.endsWith('\n') && lineCount > 1) ? lineCount - 1 : lineCount;
232 + if (s <= maxLine) {
233 +     const e = Math.min(Math.max(eRaw, s), maxLine);
234                           let start: number;
235                           let end: number;
236                           let repl: string;
```

`packages/zenith-mcp/src/tools/edit.ts` — lines +268 to +271 _(outdated)_

```diff
268 +                         failures.push(`${tag}Line range ${spec.startLine}-${spec.endLine} out of bounds (${lineCount} lines).`);
269 +                         continue;
270 +                     }
271 +                     rangeNote = `Line range ${spec.startLine}-${spec.endLine} out of bounds (${lineCount} lines); `;
```

🦾 **Copilot [AI]** · 2026-07-03 19:04:02 UTC

The out-of-bounds message uses `lineCount` from `content.split('\n')`, which counts a synthetic final empty line when the file ends with a trailing newline. That can report one extra line (e.g., a 2-line file ending with `\n` appears as 3). Since `maxLine` already represents the user-visible line count for range edits, use it in the out-of-bounds message and rangeNote.

**Suggested changeset 1:** `packages/zenith-mcp/src/tools/edit.ts`
```diff
265                           continue;
266                       }
267                       if (!hasOld) {
268 -                         failures.push(`${tag}Line range ${spec.startLine}-${spec.endLine} out of bounds (${lineCount} lines).`);
269 -                         continue;
270 -                     }
271 -                     rangeNote = `Line range ${spec.startLine}-${spec.endLine} out of bounds (${lineCount} lines); `;
268 + failures.push(`${tag}Line range ${spec.startLine}-${spec.endLine} out of bounds (${maxLine} lines).`);
269 + continue;
270 + }
271 + rangeNote = `Line range ${spec.startLine}-${spec.endLine} out of bounds (${maxLine} lines); `;
272                   }
273
274                   if (!hasOld) {
```

### Comment #10

🤖 **coderabbitai [Bot]** requested changes · 2026-07-03 19:05:22 UTC

**Actionable comments posted: 3**

`packages/zenith-mcp/src/tools/edit.ts` — lines +499 to +503 _(outdated)_

```diff
499 +                 out.push(`Edit applied sucessfully. A parsing error was detected at line ${firstParseError.line}, ${firstParseError.kind}.`);
500 +             } else if (anyUnparsed) {
501 +                 out.push('Edit applied sucessfully.');
502 +             } else {
503 +                 out.push('Edit applied sucessfully, no parsing errors detected.');
```

🤖 **coderabbitai [Bot]** · 2026-07-03 19:05:20 UTC

_📐 Maintainability & Code Quality_ | _🟡 Minor_ | _⚡ Quick win_

**Typo "sucessfully" in user-facing return strings.**

The verbatim return messages misspell "successfully" (also at Lines 25-27). These strings are returned to the caller/model. Fixing requires updating the matching assertions in `edit-tool.test.js` as well, since the tests key off these exact strings.

### Comment #11

🤖 **qodo-code-review [Bot]** commented · 2026-07-03 19:05:35 UTC

**1. Verbose edit success messages 📘 Rule violation ✧ Quality**

**Description**

The new `edit` tool returns long, descriptive success strings (e.g., `Edit applied sucessfully, no parsing errors detected.`) instead of a minimal approved success message. This violates the requirement to keep success responses short and non-descriptive by default.

**Code**

`packages/zenith-mcp/src/tools/edit.ts[R496-504]`

```diff
496 +         const out: string[] = [...failures];
497 +         if (anyWrote) {
498 +             if (firstParseError !== null) {
499 +                 out.push(`Edit applied sucessfully. A parsing error was detected at line ${firstParseError.line}, ${firstParseError.kind}.`);
500 +             } else if (anyUnparsed) {
501 +                 out.push('Edit applied sucessfully.');
502 +             } else {
503 +                 out.push('Edit applied sucessfully, no parsing errors detected.');
504 +             }
```

**Relevance**

`⭐⭐⭐ High`

Team prefers terse tool success outputs (“Moved.”/“Applied.”); verbose success prose likely rejected.

**Evidence**

PR Compliance ID 656601 requires success-path tool messages to be short (≈3 words) and match an approved minimal pattern (e.g., `Applied.`), without descriptive prose. The `edit` tool appends verbose success strings including extra diagnostic wording on the success path.

`Rule 656601: Minimize success response messages for tools`
`packages/zenith-mcp/src/tools/edit.ts[496-504]`

**Agent prompt**

```
The issue below was found during a code review. Follow the provided context and guidance below and implement a solution

## Issue description
The `edit` tool returns verbose success messages (multiple words/sentences and diagnostic phrasing). Compliance requires success responses to be very short (approved patterns like `Applied.`) and to avoid embedding extra details on success.

## Issue Context
This behavior is implemented in the new tool’s response construction logic.

## Fix Focus Areas
- packages/zenith-mcp/src/tools/edit.ts[496-504]
```

🤖 **qodo-code-review [Bot]** · 2026-07-03 19:05:35 UTC

**2. edit duplicates edit_file tool 📘 Rule violation ⌂ Architecture**

**Description**

This PR registers a new `edit` tool alongside the existing `edit_file` tool, creating overlapping tool responsibilities for editing files. This increases maintenance burden and can cause ambiguity about which tool should be used for the same capability.

**Code**

`packages/zenith-mcp/src/core/server.ts[R93-96]`

```diff
93    { name: "write_file",          register: registerWriteFile },
94    { name: "edit_file",           register: registerEditFile },
95 +   { name: "edit",                register: registerEdit },
96    { name: "directory",           register: registerDirectory },
```

**Relevance**

`⭐⭐ Medium`

No historical evidence of enforcing “no overlapping tools”; server.ts reviews focus on typing/comments (PR16).

**Evidence**

PR Compliance ID 656604 prohibits introducing new tools that overlap responsibilities already covered by existing tools instead of delegating/composing. `server.ts` registers both `edit_file` and the new `edit`, and `edit.ts` implements a full editing tool, confirming overlapping responsibilities.

`Rule 656604: Avoid overlapping tool responsibilities`
`packages/zenith-mcp/src/core/server.ts[93-96]`
`packages/zenith-mcp/src/tools/edit.ts[88-524]`

**Agent prompt**

```
The issue below was found during a code review. Follow the provided context and guidance below and implement a solution

## Issue description
A new `edit` tool is added while the existing `edit_file` tool remains registered, creating overlapping responsibilities for file editing.

## Issue Context
The compliance rule requires avoiding overlapping tool responsibilities and favors composing/delegating instead of introducing duplicate tools for the same capability.

## Fix Focus Areas
- packages/zenith-mcp/src/core/server.ts[93-96]
- packages/zenith-mcp/src/tools/edit.ts[88-524]
```

🤖 **qodo-code-review [Bot]** · 2026-07-03 19:05:35 UTC

**3. EOL tie rewrites file 🐞 Bug ≡ Correctness**

**Description**

In `edit`, EOL selection uses strict `&gt;` comparisons, so a file with equal CRLF and LF counts defaults to ``, and the subsequent write rewrites the entire file with LF endings. This can cause large unintended diffs and break workflows expecting CRLF preservation in mixed-ending files.

**Code**

`packages/zenith-mcp/src/tools/edit.ts[R189-195]`

```diff
202 +             const crlfCount = noBom.split('\r\n').length - 1;
203 +             const loneCrCount = noBom.split('\r').length - 1 - crlfCount;
204 +             const loneLfCount = noBom.split('\n').length - 1 - crlfCount;
205 +             let eol = '\n';
206 +             if (crlfCount > loneLfCount && crlfCount >= loneCrCount) eol = '\r\n';
207 +             else if (loneCrCount > loneLfCount && loneCrCount > crlfCount) eol = '\r';
208 +             const content = normalizeEols(noBom);
```

**Relevance**

`⭐⭐ Medium`

No historical review suggestions found about EOL-dominance tie cases or preventing CRLF/LF rewrite behavior.

**Evidence**

The EOL heuristic defaults to `` unless CRLF strictly exceeds LF, and the write path applies the chosen EOL to the entire reconstructed file, so tie cases will rewrite CRLF lines to LF.

`packages/zenith-mcp/src/tools/edit.ts[184-195]`
`packages/zenith-mcp/src/tools/edit.ts[396-416]`

**Agent prompt**

```
The issue below was found during a code review. Follow the provided context and guidance below and implement a solution

### Issue description
The edit tool’s “dominant EOL” detection defaults to `\n` when counts tie (e.g., `crlfCount === loneLfCount`), which can normalize a mixed-EOL file to LF even when CRLF is at least as prevalent. Because the tool rewrites the full file content after editing, this can create unintended full-file EOL changes.

### Issue Context
- EOL choice is computed from counts and then applied to the entire rebuilt file.
- Tie behavior currently favors `\n`.

### Fix Focus Areas
- packages/zenith-mcp/src/tools/edit.ts[189-195]
- packages/zenith-mcp/src/tools/edit.ts[415-415]

### Suggested change
Update EOL selection to be stable under ties, e.g.:
- Prefer CRLF when `crlfCount >= loneLfCount` and `crlfCount >= loneCrCount` (and `crlfCount > 0`), or
- Choose the first encountered line-ending in the original text as the tie-breaker, or
- Preserve the original file’s EOL if the file is already uniform; only normalize when there is a strict majority.
```

🤖 **qodo-code-review [Bot]** · 2026-07-03 19:05:35 UTC

**4. MD5 dedup integrity risk 🐞 Bug ☼ Reliability**

**Description**

Patch snapshots are deduplicated using an MD5 `text_hash`, so an MD5 collision would cause distinct patches to be treated as identical (due to `INSERT OR IGNORE`) and could surface the wrong patch in history/undo. This is unlikely in normal use but is avoidable by using a stronger hash and/or verifying equality on dedup hits.

**Code**

`packages/zenith-mcp/src/core/symbol-index.ts[R499-511]`

```diff
498 + export function snapshotEdit(db: DbConnection, relPath: string, oldText: string, newText: string, line: number, sessionId: string): void {
499 +     // Length-prefixed framing so (old, new) pairs hash unambiguously - a bare
500 +     // separator would let ("a|", "b") and ("a", "|b") collide.
501 +     const textHash = createHash('md5').update(`${oldText.length}:`).update(oldText).update(newText).digest('hex');
502 +     snapshotEditVersion(db, {
503 +         filePath: relPath,
504 +         oldText,
505 +         newText,
506 +         line,
507 +         sessionId,
508 +         createdAt: Date.now(),
509 +         textHash,
510 +     });
```

**Relevance**

`⭐⭐ Medium`

No prior accepted/rejected guidance on MD5 vs stronger hashes for dedup text_hash in versions snapshots.

**Evidence**

The code hashes patches with MD5 and uses that hash as part of a unique dedup index, with `INSERT OR IGNORE` meaning collisions collapse rows and prevent storing distinct patches.

`packages/zenith-mcp/src/core/symbol-index.ts[499-511]`
`packages/zenith-mcp/src/core/db-adapter.ts[154-186]`
`packages/zenith-mcp/src/core/db-adapter.ts[794-816]`

**Agent prompt**

```
The issue below was found during a code review. Follow the provided context and guidance below and implement a solution

### Issue description
The patch snapshot dedup key uses MD5 (`text_hash`). While collisions are unlikely accidentally, MD5 collisions are known to be constructible; a collision here would collapse two distinct patches into one row and could make later retrieval/undo/reapply operate on the wrong patch.

### Issue Context
- `snapshotEdit()` computes `textHash` with MD5.
- The `versions` table unique index dedups on `(symbol_name, file_path, text_hash, session_id)`.
- `snapshotEditVersion()` uses `INSERT OR IGNORE`, so a colliding hash prevents insertion.

### Fix Focus Areas
- packages/zenith-mcp/src/core/symbol-index.ts[499-511]
- packages/zenith-mcp/src/core/db-adapter.ts[179-179]
- packages/zenith-mcp/src/core/db-adapter.ts[808-816]

### Suggested change
- Switch `textHash` to SHA-256 (or similar) for patch snapshots (and optionally for other version hashes for consistency).
- Optionally harden dedup further by, on an `INSERT OR IGNORE` hit, selecting the existing row and verifying `original_text` and `new_text` match before treating it as the same patch (if not equal, fall back to inserting with a different/extended dedup key).
```

### Comment #12

🤖 **qodo-code-review [Bot]** reviewed · 2026-07-03 19:05:36 UTC

`packages/zenith-mcp/src/tools/edit.ts` — lines +638 to +646

```diff
496 +         const out: string[] = [...failures];
497 +         if (anyWrote) {
498 +             if (firstParseError !== null) {
499 +                 out.push(`Edit applied sucessfully. A parsing error was detected at line ${firstParseError.line}, ${firstParseError.kind}.`);
500 +             } else if (anyUnparsed) {
501 +                 out.push('Edit applied sucessfully.');
502 +             } else {
503 +                 out.push('Edit applied sucessfully, no parsing errors detected.');
504 +             }
```

🤖 **qodo-code-review [Bot]** · 2026-07-03 19:05:36 UTC

1. Verbose `edit` success messages `📘 Rule violation` `✧ Quality`

The new `edit` tool returns long, descriptive success strings (e.g., `Edit applied sucessfully, no parsing errors detected.`) instead of a minimal approved success message. This violates the requirement to keep success responses short and non-descriptive by default.

**Agent Prompt**

```
## Issue description
The `edit` tool returns verbose success messages (multiple words/sentences and diagnostic phrasing). Compliance requires success responses to be very short (approved patterns like `Applied.`) and to avoid embedding extra details on success.

## Issue Context
This behavior is implemented in the new tool’s response construction logic.

## Fix Focus Areas
- packages/zenith-mcp/src/tools/edit.ts[496-504]
```

`packages/zenith-mcp/src/core/server.ts` — lines +93 to +96

```diff
93     { name: "write_file",          register: registerWriteFile },
94     { name: "edit_file",           register: registerEditFile },
95 +   { name: "edit",                register: registerEdit },
96     { name: "directory",           register: registerDirectory },
```

🤖 **qodo-code-review [Bot]** · 2026-07-03 19:05:36 UTC

2. `edit` duplicates `edit_file` tool `📘 Rule violation` `⌂ Architecture`

This PR registers a new `edit` tool alongside the existing `edit_file` tool, creating overlapping tool responsibilities for editing files. This increases maintenance burden and can cause ambiguity about which tool should be used for the same capability.

**Agent Prompt**

```
## Issue description
A new `edit` tool is added while the existing `edit_file` tool remains registered, creating overlapping responsibilities for file editing.

## Issue Context
The compliance rule requires avoiding overlapping tool responsibilities and favors composing/delegating instead of introducing duplicate tools for the same capability.

## Fix Focus Areas
- packages/zenith-mcp/src/core/server.ts[93-96]
- packages/zenith-mcp/src/tools/edit.ts[88-524]
```

### Comment #13

🤖 **cubic-dev-ai [Bot]** reviewed · 2026-07-03 19:09:19 UTC

**2 issues found** across 6 files

Reply with feedback, questions, or to request a fix.

Re-trigger cubic

`packages/zenith-mcp/src/core/symbol-index.ts` — line +508

```diff
506 +         newText,
507 +         line,
508 +         sessionId,
509 +         createdAt: Date.now(),
```

🤖 **cubic-dev-ai [Bot]** · 2026-07-03 19:09:20 UTC

P2: Batched edits can record multiple patch snapshots with the same millisecond `created_at`, and `getVersionHistory` orders only by `created_at`, so the “newest patch” returned for undo/reuse can be nondeterministic when two snapshots land in the same millisecond. It would be safer to add the same deterministic tie-breaker used by retention (for example `ORDER BY created_at DESC, id DESC`) or otherwise make patch timestamps monotonic.

`packages/zenith-mcp/tests/edit-tool.test.js` — line +924

```diff
665 +         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
666 +         const p = mkFile('a.txt', 'A\n');
667 +         await run(p, [{ startLine: 1, endLine: 1, newContent: 'B' }]); // patch A->B
668 +         await sleep(5);
```

🤖 **cubic-dev-ai [Bot]** · 2026-07-03 19:09:20 UTC

P3: The `sleep(5)` calls in the snapshot dedup test create a potential for flaky CI failures when system timer resolution exceeds 5ms. Consider increasing the sleep to 20ms or removing the dependency on wall-clock time entirely (e.g., using a deterministic timestamp mock).

### Comment #14

🦾 **copilot-pull-request-reviewer [AI]** reviewed · 2026-07-09 10:07:15 UTC

## Pull request overview

Copilot reviewed 6 out of 6 changed files in this pull request and generated 2 comments.

`packages/zenith-mcp/src/tools/edit.ts` — lines +545 to +546

```diff
543 +                 const gap = content.slice(pos, c.start);
544 +                 const oldText = content.slice(c.start, c.end);
545 +                 originalLine += gap.split('\n').length - 1;
546 +                 patches.push({ oldText, newText: c.repl, line: originalLine });
```

🦾 **Copilot [AI]** · 2026-07-09 10:07:15 UTC

Patch snapshots derive `line` from the claim's starting character offset. For line-range deletions at EOF in a file without a trailing newline, the deletion claim starts on the preceding newline (end of the previous line), so the stored `line` becomes off-by-one (previous line) even though the deleted range starts at the next line. Adjusting the computed snapshot line when the replaced span begins with a newline keeps `line` aligned with the first affected line.

**Suggested changeset 1:** `packages/zenith-mcp/src/tools/edit.ts`
```diff
542               for (const c of claims) {
543                   const gap = content.slice(pos, c.start);
544                   const oldText = content.slice(c.start, c.end);
545 -                 originalLine += gap.split('\n').length - 1;
546 -                 patches.push({ oldText, newText: c.repl, line: originalLine });
545 + originalLine += gap.split('\n').length - 1;
546 + const patchLine = oldText.startsWith('\n') ? originalLine + 1 : originalLine;
547 + patches.push({ oldText, newText: c.repl, line: patchLine });
548                   originalLine += oldText.split('\n').length - 1;
549                   rebuilt += gap + c.repl;
550                   pos = c.end;
```

### Comment #15

🤖 **coderabbitai [Bot]** requested changes · 2026-07-09 10:11:31 UTC

**Actionable comments posted: 1**

> Some comments are outside the diff and can’t be posted inline due to platform limitations.

**⚠️ Outside diff range comments (2)**

**packages/zenith-mcp/src/tools/edit.ts (2)**

`344-386`: _🎯 Functional Correctness_ | _🟠 Major_ | _🏗️ Heavy lift_

**Refuse ambiguous content matches before editing.**

Tier 1 and Tier 2 stop at the first non-overlapping match, and Tier 3 still picks the first same-shift duplicate. If `oldContent` appears in multiple places, the tool can modify the earliest occurrence instead of refusing to guess, which contradicts the PR’s ambiguity contract.

Also applies to: 399-431

---

`658-659`: _🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_

**Reject non-positive line numbers in the schema.** `startLine` and `endLine` are 1-based, but `0` and negatives still pass and get clamped to line 1 in the range handler, so malformed input can edit the wrong line. Add `.min(1)` to both fields.

_Source: Coding guidelines_

`packages/zenith-mcp/src/tools/edit.ts` — lines +294 to +296

```diff
293 +                             // not a dedent-to-zero.
294 +                             if (repl === oldText && text !== oldText) {
295 +                                 const firstNew = text.split('\n').find(l => l.trim() !== '');
296 +                                 if (firstNew !== undefined && leadingWhitespace(firstNew) !== '') repl = text;
```

🤖 **coderabbitai [Bot]** · 2026-07-09 10:11:31 UTC

_🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_

**Preserve all-whitespace indentation fixes.**

`find(l => l.trim() !== '')` skips replacements made only of spaces/tabs, so the “do not neutralize whitespace intent” guard does not restore the caller’s bytes for blank or indent-only lines.

**Proposed fix**

```diff
295 -                                 const firstNew = text.split('\n').find(l => l.trim() !== '');
296 -                                 if (firstNew !== undefined && leadingWhitespace(firstNew) !== '') repl = text;
295 +                                 const firstNew = text.split('\n').find(l => l.trim() !== '');
296 +                                 if (
297 +                                     (firstNew !== undefined && leadingWhitespace(firstNew) !== '') ||
298 +                                     (firstNew === undefined && /[ \t]/.test(text))
299 +                                 ) repl = text;
```

```diff
524 -                         const firstNew = newNorm.split('\n').find(l => l.trim() !== '');
525 -                         if (firstNew !== undefined && leadingWhitespace(firstNew) !== '') repl = newNorm;
524 +                         const firstNew = newNorm.split('\n').find(l => l.trim() !== '');
525 +                         if (
526 +                             (firstNew !== undefined && leadingWhitespace(firstNew) !== '') ||
527 +                             (firstNew === undefined && /[ \t]/.test(newNorm))
528 +                         ) repl = newNorm;
```

Also applies to: 523-525

### Comment #16

🤖 **sonarqubecloud [Bot]** commented · 2026-07-09 10:13:39 UTC

## **Quality Gate failed**
Failed conditions
 D Security Rating on New Code (required ≥ A)

See analysis details on SonarQube Cloud

##
💡 **Need a hand with PR review?** Try Gitar by Sonar!

### Comment #17

🧑 **itstanner5216** commented · 2026-07-09 10:17:34 UTC

@gemini please review this pr
@claude review once

### Comment #18

🧑 **itstanner5216** commented · 2026-07-09 10:18:18 UTC

@sonarqube-agent[agent] please review this pr's latest commits, post your review findings as a comment.

### Comment #19

🤖 **cubic-dev-ai [Bot]** reviewed · 2026-07-09 10:20:19 UTC

**2 issues found across 4 files (changes from recent commits).**

**Tip**: Review your code locally with the cubic CLI to iterate faster.

Re-trigger cubic

`packages/zenith-mcp/src/tools/edit.ts` — line +141

```diff
138 +         let anyUnparsed = false;
139 +
140 +         for (const group of groups) {
141 +             const fileTag = multiFile ? `${path.basename(group.givenPath)}: ` : '';
```

🤖 **cubic-dev-ai [Bot]** · 2026-07-09 10:20:19 UTC

P2: fileTag for multi-file edits now uses `path.basename(givenPath)` which drops directory context. When two files with the same basename exist in different directories (e.g. `src/foo/config.ts` and `tests/foo/config.ts`), the error message becomes ambiguous and the caller cannot tell which file failed.

`packages/zenith-mcp/src/tools/edit.ts` — line +331

```diff
328 +                 // A stripped-to-empty oldContent ("\n") is a blank-LINE needle,
329 +                 // resolved by the whole-line tier — never by raw char search.
330 +                 // A lone "\n" newContent survives (it means a blank line).
331 +                 if (oldNorm.endsWith('\n')) oldNorm = oldNorm.slice(0, -1);
```

🤖 **cubic-dev-ai [Bot]** · 2026-07-09 10:20:19 UTC

P2: Content edits that include a copied trailing newline can now match only a prefix of a longer line. Since `oldContent` has its newline stripped before the exact `indexOf` tier runs, `oldContent: "foo\n"` can match the `foo` in `foobar\n` and replace just that substring. It would be safer to remember that the caller supplied a trailing newline and require the exact-tier candidate to end at a line boundary (or skip to the whole-line tiers) before accepting it.

### Comment #20

🤖 **gemini-code-assist [Bot]** reviewed · 2026-07-09 10:21:44 UTC

## Code Review

This pull request introduces a new `edit` tool to the Zenith MCP package, allowing precise file modifications via line ranges or content matching with robust indentation forgiveness, atomic writes, and syntax-error reporting. To support this, database schema migrations and adapter functions were added to snapshot per-edit patches in the `versions` table, and the tree-sitter integration was enhanced to return syntax error kinds. Comprehensive test suites were also added to verify the tool's behavior. The review feedback suggests optimizing the string reconstruction loop in the `edit` tool by using an array and `join()` instead of repeated string concatenation to improve performance on large files.

`packages/zenith-mcp/src/tools/edit.ts` — lines +539 to +551

```diff
539 +             let rebuilt = '';
540 +             let pos = 0;
541 +             let originalLine = 1;
542 +             for (const c of claims) {
543 +                 const gap = content.slice(pos, c.start);
544 +                 const oldText = content.slice(c.start, c.end);
545 +                 originalLine += gap.split('\n').length - 1;
546 +                 patches.push({ oldText, newText: c.repl, line: originalLine });
547 +                 originalLine += oldText.split('\n').length - 1;
548 +                 rebuilt += gap + c.repl;
549 +                 pos = c.end;
550 +             }
551 +             rebuilt += content.slice(pos);
```

🤖 **gemini-code-assist [Bot]** · 2026-07-09 10:21:44 UTC

Repeated string concatenation in a loop (`rebuilt += gap + c.repl`) can lead to unnecessary memory allocations and performance degradation, especially when processing large files with many edits. Using an array to collect the segments and joining them at the end is more efficient and idiomatic in JavaScript/TypeScript.

**Suggested changeset 1:** `packages/zenith-mcp/src/tools/edit.ts`
```diff
536               // unit the snapshot layer stores.
537               claims.sort((a, b) => a.start - b.start || a.editIndex - b.editIndex);
538               const patches: Array<{ oldText: string; newText: string; line: number }> = [];
539 -             let rebuilt = '';
539 +             const rebuiltParts: string[] = [];
540               let pos = 0;
541               let originalLine = 1;
542               for (const c of claims) {
543                   const gap = content.slice(pos, c.start);
544                   const oldText = content.slice(c.start, c.end);
545 -                 originalLine += gap.split('\n').length - 1;
545 +                 originalLine += gap.split('\\n').length - 1;
546                   patches.push({ oldText, newText: c.repl, line: originalLine });
547 -                 originalLine += oldText.split('\n').length - 1;
548 -                 rebuilt += gap + c.repl;
547 +                 originalLine += oldText.split('\\n').length - 1;
548 +                 rebuiltParts.push(gap, c.repl);
549                   pos = c.end;
550               }
551 -             rebuilt += content.slice(pos);
551 +             rebuiltParts.push(content.slice(pos));
552 +             const rebuilt = rebuiltParts.join('');
```

### Comment #21

🦾 **copilot-pull-request-reviewer [AI]** reviewed · 2026-07-09 10:23:14 UTC

## Pull request overview

Copilot reviewed 6 out of 6 changed files in this pull request and generated 1 comment.

`packages/zenith-mcp/src/core/db-adapter.ts` — lines +871 to +881

```diff
872 +  * SQL: DELETE FROM versions WHERE created_at < ? AND symbol_name NOT LIKE 'file://%'
873 +  *
874 +  * Edit-patch rows (symbol_name 'file://<relPath>') are excluded: their
875 +  * retention is the EDIT_SNAPSHOT_CAP newest per session/file, enforced in
876 +  * snapshotEditVersion — the refactor TTL must not silently erode undo
877 +  * history beneath that cap.
878    */
879   export function pruneOldVersions(conn: DbConnection, beforeTimestamp: number): void {
804 -     prepareOrCache(conn, 'DELETE FROM versions WHERE created_at < ?')
880 +     prepareOrCache(conn, "DELETE FROM versions WHERE created_at < ? AND symbol_name NOT LIKE 'file://%'")
881           .run(beforeTimestamp);
```

🦾 **Copilot [AI]** · 2026-07-09 10:23:13 UTC

Excluding `file://…` edit-patch rows from `pruneOldVersions()` means patch history is now never age-pruned (only capped per session/file). Over time (many sessions and many edited files) `versions` can grow without bound, which can impact DB size and performance.

Consider adding an additional pruning policy for `file://%` rows (e.g., an age-based TTL, or a global cap per file across all sessions), so patch snapshots don’t accumulate indefinitely.

---

## Resolved

### Resolved Comment #1

🦾 **Copilot [AI]** reviewed · 2026-07-03 09:29:49 UTC

`packages/zenith-mcp/src/tools/edit.ts` — lines +420 to +421

```diff
418 +                 }
419 +             }
420 +             // Every write is preceded by a snapshot of the exact original
421 +             // bytes, keyed per session/file for the undo tool.
```

The snapshot comment says "exact original bytes", but this code reads/snapshots a UTF-8 string (`raw`) and stores it in a TEXT column. Consider wording this as "exact original text/contents" (including BOM/EOL) to avoid implying binary-safe byte preservation.

**Suggested changeset 1:** `packages/zenith-mcp/src/tools/edit.ts`
```diff
418                   }
419               }
420               // Every write is preceded by a snapshot of the exact original
421 -             // bytes, keyed per session/file for the undo tool.
421 +             // text/contents (including BOM and EOL style), keyed per session/file for the undo tool.
422               if (db !== null && repoRoot !== null) {
423                   try {
424                       snapshotFile(db, path.relative(repoRoot, absPath), raw, ctx.sessionId ?? getSessionId());
```

### Resolved Comment #2

🦾 **Copilot [AI]** reviewed · 2026-07-03 09:29:49 UTC

`packages/zenith-mcp/src/core/symbol-index.ts` — lines +488 to +492

```diff
488 +  * File-level pre-edit snapshot: the whole-file counterpart of
489 +  * {@link snapshotSymbol}, written by the edit tool before every file write so
490 +  * a future undo can restore the exact pre-edit bytes. Keying and retention
491 +  * (10 most recent per session/file scope) live in the db-adapter's
492 +  * snapshotFileVersion.
```

This docstring says snapshots restore the "exact pre-edit bytes", but the snapshot stores a JS string into `versions.original_text` (TEXT). Rewording to "exact pre-edit text/contents" would be more accurate.

**Suggested changeset 1:** `packages/zenith-mcp/src/core/symbol-index.ts`
```diff
487   /**
488    * File-level pre-edit snapshot: the whole-file counterpart of
489    * {@link snapshotSymbol}, written by the edit tool before every file write so
490 -  * a future undo can restore the exact pre-edit bytes. Keying and retention
490 +  * a future undo can restore the exact pre-edit text/contents. Keying and retention
491    * (10 most recent per session/file scope) live in the db-adapter's
492    * snapshotFileVersion.
493    */
```

### Resolved Comment #3

🤖 **macroscopeapp [Bot]** reviewed · 2026-07-03 09:33:39 UTC

`packages/zenith-mcp/src/tools/edit.ts` — line +420

```diff
417 +                     db = null;
418 +                 }
419 +             }
420 +             // Every write is preceded by a snapshot of the exact original
```

🟡 **Medium** `tools/edit.ts:420`

`snapshotFile` is called before the write attempt, but when the write fails (e.g., `rename` throws), the pre-edit snapshot is left in the database even though the file was never changed. This creates phantom undo history entries for edits that never happened and can evict real snapshots from the 10-entry retention cap. Consider moving the `snapshotFile` call to after the successful `rename`, or removing the snapshot in the write-failure `catch` block.

✅ Resolved in c9981dd10fa787b7c203a16a5585bdd090c2ba43

### Resolved Comment #4

🤖 **macroscopeapp [Bot]** reviewed · 2026-07-03 09:33:39 UTC

`packages/zenith-mcp/src/tools/edit.ts` — line +88

```diff
85 +     return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
86 + }
87 +
88 + export function register(server: ToolServer, ctx: ToolContext): void {
```

🟡 **Medium** `tools/edit.ts:88`

The tool reads the target file with `fs.readFile(absPath, 'utf-8')` and writes it back with `fs.writeFile(tempPath, finalText, 'utf-8')`. For a non-UTF-8 or binary file, the read decodes invalid byte sequences as `U+FFFD` replacement characters, and the subsequent UTF-8 write persists those replacement characters — silently corrupting the file instead of rejecting the edit. Consider validating that the content is valid UTF-8 (or detecting non-text files) before performing the edit.

✅ Resolved in c9981dd10fa787b7c203a16a5585bdd090c2ba43

### Resolved Comment #5

🤖 **macroscopeapp [Bot]** reviewed · 2026-07-03 09:45:16 UTC

`packages/zenith-mcp/src/core/db-adapter.ts` — line +809

```diff
805 + ): void {
806 +     const symbolName = `file://${entry.filePath}`;
807 +     runTransaction(conn, () => {
808 +         const inserted = prepareOrCache(conn, 'INSERT OR IGNORE INTO versions (symbol_name, file_path, original_text, new_text, session_id, created_at, line, text_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
```

🟡 **Medium** `core/db-adapter.ts:808`

Rows inserted here into `versions` with `symbol_name = 'file://…'` are silently deleted by `pruneOldVersions` on the next `getDb()` call once they exceed the refactor TTL (24 h by default). This means edit snapshots are lost even when a file has fewer than `EDIT_SNAPSHOT_CAP` entries, breaking undo/reuse history. `pruneOldVersions` needs to exclude edit-patch rows (e.g. `WHERE symbol_name NOT LIKE 'file://%'`), or edit patches should be stored in a separate table.

No longer relevant as of c9981dd10fa787b7c203a16a5585bdd090c2ba43

### Resolved Comment #6

🤖 **coderabbitai [Bot]** reviewed · 2026-07-03 19:05:20 UTC

`packages/zenith-mcp/src/tools/edit.ts` — lines +434 to +462

```diff
434 +             if (db !== null && repoRoot !== null) {
435 +                 try {
436 +                     const relPath = path.relative(repoRoot, absPath);
437 +                     const sessionId = ctx.sessionId ?? getSessionId();
438 +                     for (const p of patches) {
439 +                         snapshotEdit(db, relPath, p.oldText, p.newText, p.line, sessionId);
440 +                     }
441 +                 } catch { /* snapshotting is a safety net; never fail the edit */ }
442 +             }
443 +
444 +             // ── Atomic write: temp → chmod (exact original mode; chmod is not
445 +             // umask-masked, writeFile's mode option is) → best-effort chown →
446 +             // rename. The temp file is removed on every failure path.
447 +             const tempPath = `${absPath}.${randomBytes(8).toString('hex')}.tmp`;
448 +             try {
449 +                 await fs.writeFile(tempPath, finalText, 'utf-8');
450 +                 await fs.chmod(tempPath, fileMode);
451 +                 try {
452 +                     await fs.chown(tempPath, fileUid, fileGid);
453 +                 } catch { /* ownership is best-effort — never fail an edit over chown */ }
454 +                 await fs.rename(tempPath, absPath);
455 +             } catch (error) {
456 +                 try { await fs.unlink(tempPath); } catch { /* already gone */ }
457 +                 const code = (error as NodeJS.ErrnoException).code;
458 +                 failures.push(`${fileTag}${code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
459 +                     ? 'File not writable.'
460 +                     : `Write failed${code ? ` (${code})` : ''}.`}`);
461 +                 continue;
462 +             }
```

_🗄️ Data Integrity & Integration_ | _🔵 Trivial_ | _💤 Low value_

**Snapshots are persisted before the write is confirmed.**

Per-edit snapshots are written at Lines 434-442, but the atomic write can still fail at Lines 447-462 (`continue` without setting `anyWrote`). This leaves a persisted snapshot for an edit that never landed on disk. It's low-impact today (undo/re-apply match by content, so a missing `new_text` is a no-op), but the snapshot layer would be more consistent if it recorded only after `fs.rename` succeeds.

✅ Addressed in commits 23f3f9b to c9981dd

### Resolved Comment #7

🤖 **coderabbitai [Bot]** reviewed · 2026-07-03 19:05:20 UTC

`packages/zenith-mcp/src/tools/edit.ts` — lines +444 to +462

```diff
444 +             // ── Atomic write: temp → chmod (exact original mode; chmod is not
445 +             // umask-masked, writeFile's mode option is) → best-effort chown →
446 +             // rename. The temp file is removed on every failure path.
447 +             const tempPath = `${absPath}.${randomBytes(8).toString('hex')}.tmp`;
448 +             try {
449 +                 await fs.writeFile(tempPath, finalText, 'utf-8');
450 +                 await fs.chmod(tempPath, fileMode);
451 +                 try {
452 +                     await fs.chown(tempPath, fileUid, fileGid);
453 +                 } catch { /* ownership is best-effort — never fail an edit over chown */ }
454 +                 await fs.rename(tempPath, absPath);
455 +             } catch (error) {
456 +                 try { await fs.unlink(tempPath); } catch { /* already gone */ }
457 +                 const code = (error as NodeJS.ErrnoException).code;
458 +                 failures.push(`${fileTag}${code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
459 +                     ? 'File not writable.'
460 +                     : `Write failed${code ? ` (${code})` : ''}.`}`);
461 +                 continue;
462 +             }
```

_🔒 Security & Privacy_ | _🟡 Minor_ | _⚡ Quick win_

**Swap `chown` and `chmod` here.** `chown(2)` can clear `S_ISUID`/`S_ISGID` when ownership changes, so `chmod`-then-`chown` won’t preserve the original mode on files with those bits. Running `chown` first keeps the exact mode intact.

✅ Addressed in commits 23f3f9b to c9981dd

### Resolved Comment #8

🤖 **cubic-dev-ai [Bot]** reviewed · 2026-07-03 19:09:20 UTC

`packages/zenith-mcp/src/tools/edit.ts` — line +218

```diff
215 +
216 +             const claims: Claim[] = [];
217 +             const overlapsClaim = (start: number, end: number): Claim | undefined =>
218 +                 claims.find(c => start < c.end && c.start < end);
```

P1: Edits that start at the same original offset can slip past overlap checks when one resolved span is zero-length (for example, replacing an empty line). In that case both claims are accepted, and the rebuild pass can rewind `pos` and reintroduce text from a region that should have been removed. Tightening the overlap predicate to treat same-start point spans inside an existing claim as conflicting would keep batch results deterministic and prevent content corruption.

✅ Addressed in `f920db9`

### Resolved Comment #9

🤖 **cubic-dev-ai [Bot]** reviewed · 2026-07-03 19:09:20 UTC

`packages/zenith-mcp/src/tools/edit.ts` — line +450

```diff
447 +             const tempPath = `${absPath}.${randomBytes(8).toString('hex')}.tmp`;
448 +             try {
449 +                 await fs.writeFile(tempPath, finalText, 'utf-8');
450 +                 await fs.chmod(tempPath, fileMode);
```

P2: `chown(2)` clears the `S_ISUID`/`S_ISGID` bits when ownership changes. With the current `chmod`→`chown` ordering, files that originally had setuid or setgid bits will lose them after the edit, even though the intent is to preserve the exact original mode. Swap the order to `chown` first, then `chmod`, so the mode bits set by `chmod` are not subsequently cleared.

✅ Addressed in `f920db9`

### Resolved Comment #10

🤖 **cubic-dev-ai [Bot]** reviewed · 2026-07-03 19:09:20 UTC

`packages/zenith-mcp/src/tools/edit.ts` — line +438

```diff
435 +                 try {
436 +                     const relPath = path.relative(repoRoot, absPath);
437 +                     const sessionId = ctx.sessionId ?? getSessionId();
438 +                     for (const p of patches) {
```

P3: Patch snapshots are persisted before the atomic write is confirmed (before `fs.rename` succeeds). If the write fails at the rename step, the snapshot remains in the database for an edit that never landed on disk. While low-impact today (undo matches by content), moving the snapshot persistence to after a successful rename would make the snapshot layer more consistent.

✅ Addressed in `f920db9`

### Resolved Comment #11

🦾 **Copilot [AI]** reviewed · 2026-07-09 10:07:15 UTC

`packages/zenith-mcp/src/core/symbol-index.ts` — lines +489 to +490

```diff
487
488 + /**
489 +  * Per-edit patch snapshot: the edit-tool counterpart of
490 +  * {@link snapshotSymbol}, written before every file write — one row per
```

The patch snapshot JSDoc says snapshots are "written before every file write", but the edit tool records snapshots only after a confirmed rename succeeds. This mismatch is likely to mislead future changes (and conflicts with the intended behavior in the edit tool/tests).

**Suggested changeset 1:** `packages/zenith-mcp/src/core/symbol-index.ts`
```diff
486   }
487
488   /**
489 -  * Per-edit patch snapshot: the edit-tool counterpart of
490 -  * {@link snapshotSymbol}, written before every file write — one row per
489 +  * {@link snapshotSymbol}, recorded only after a confirmed write (rename succeeded) — one row per
490    * applied edit holding the literal patch (exact replaced text, exact
491    * replacement as applied, original start line). A future undo tool reverses
492    * the newest patch by content, which survives line drift; the stored
```

---

## Checks

12 successful · 0 in progress · 2 failed

- ✗ SonarCloud Code Analysis — Failed in 33s
- ✗ SonarQube — Failed in 22s
- ✓ Macroscope - Approvability Check — Neutral in 1m 19s
- ✓ Macroscope - Correctness Check — Skipped in 5s
- ✓ sonarqube-agent — Successful in 2m 16s
- ✓ copilot — Successful in 7m 55s
- ✓ semgrep-cloud-platform/scan — Successful in 2m 50s
- ✓ cubic · AI code reviewer — Successful in 7m 16s
- ✓ copilot-pull-request-reviewer — Successful in 5m 2s
- ✓ Socket Security: Pull Request Alerts — Successful in 3s
- ✓ Build & Test — Successful in 1m 25s
- ✓ Socket Security: Project Report — Successful in 6s
- ✓ GitGuardian Security Checks — Successful in 0ms
- ✓ CodeRabbit — Successful in 0ms

---

**Merging is blocked** — merge conflicts, 2 changes requested, 2 checks failed.
