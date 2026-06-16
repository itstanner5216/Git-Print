### Comment #61

**cubic-dev-ai [Bot]** reviewed · 2026-06-15 14:23:33 UTC

`packages/zenith-mcp/src/core/indexing/resolve.ts` — line +68

```diff
65 +         const shortName = name.slice(dotIdx + 1);
66 +         const shortCandidates = findDefsByName(conn, shortName, 'def');
67 +         const underQualifier = shortCandidates.filter((c) => {
68 +             const parent = findSymbolParent(conn, c.id);
```

P2: Dot-qualified resolution introduces N+1 DB lookups for parent checks. Large candidate sets will noticeably slow resolveAllEdgeTargets.

### Comment #62

**cubic-dev-ai [Bot]** reviewed · 2026-06-15 14:23:33 UTC

`packages/zenith-toon/src/string-codec.ts` — line +1870

```diff
1867 +     // SageRank tuning transform: damp raw call counts with sqrt so a hot edge
1868 +     // (many calls) doesn't linearly dominate AST ranking. Per Priority 0.5 this
1869 +     // edge-weighting decision lives in TOON; MCP hands across the raw callCount.
1870 +     callGraph: facts.edges.map((e) => ({ caller: e.callerName, callee: e.calleeName, weight: Math.sqrt(e.callCount) })),
```

P2: Normalize-free call counts are expected here; applying `Math.sqrt` changes the graph signal and can under-rank hot callers compared with the raw counts already emitted upstream.

**Suggested changeset 1:** `packages/zenith-toon/src/string-codec.ts`
```diff
@@ -1867,4 +1867,4 @@ export function compressSourceStructured(
     // SageRank tuning transform: damp raw call counts with sqrt so a hot edge
     // (many calls) doesn't linearly dominate AST ranking. Per Priority 0.5 this
     // edge-weighting decision lives in TOON; MCP hands across the raw callCount.
-    callGraph: facts.edges.map((e) => ({ caller: e.callerName, callee: e.calleeName, weight: Math.sqrt(e.callCount) })),
+    callGraph: facts.edges.map((e) => ({ caller: e.callerName, callee: e.calleeName, weight: e.callCount })),
```

### Comment #63

**Copilot [AI]** reviewed · 2026-06-15 16:02:50 UTC

`packages/zenith-mcp/src/core/indexing/extract.ts` — lines +169 to +178

```diff
169 +         const locals: LocalScopeRow[] = (localScopes ?? []).map(scope => {
170 +             let parentKey: string | null = null;
171 +             for (const d of defs) {
172 +                 if (d.line <= scope.startLine && d.endLine >= scope.endLine) {
173 +                     parentKey = `${d.name}:${d.line}:${d.column}`;
174 +                     break;
175 +                 }
176 +             }
177 +             return { parentSymbolKey: parentKey, scopeKind: scope.scopeKind, startLine: scope.startLine, endLine: scope.endLine, parameters: scope.parameters, locals: scope.locals };
178 +         });
```

Local-scope parentSymbolKey is currently chosen as the first enclosing def in `defs`, which will attach nested scopes to an outer definition rather than the tightest containing definition. This breaks parent linkage for locals in nested functions/methods and makes downstream per-symbol locals inaccurate.

### Comment #64

**Copilot [AI]** reviewed · 2026-06-15 16:02:51 UTC

`packages/zenith-mcp/src/core/compression.ts` — lines +37 to +41

```diff
37 +     if (repoRoot) {
38 +         try {
39 +             const db = getDb(repoRoot);
40 +             const relPath = path.relative(repoRoot, validPath);
41 +             dbFacts = getFileFacts(db, relPath);
```

compressForTool reads symbol facts from the DB via getFileFacts() but does not call ensureIndexFresh() first. That means defs/anchors/edges may be stale (or missing entirely) relative to the rawText being compressed, producing misaligned line facts and degraded/incorrect structured compression.

### Comment #65

**Copilot [AI]** reviewed · 2026-06-15 16:02:51 UTC

`packages/zenith-mcp/src/core/indexing/types.ts` — line +16

```diff
13 +     line: number;               // 1-based
14 +     endLine: number;            // 1-based
15 +     column: number;
16 +     bodyHash: string | null;    // sha1 for defs only
```

The SymbolRow.bodyHash comment says "sha1" but bodyHash() is implemented using SHA-256 (and tests pin 64-hex output). This comment is now misleading for anyone working on the extractor/persister contract.

### Comment #66

**Copilot [AI]** reviewed · 2026-06-15 16:02:51 UTC

`packages/zenith-mcp/src/core/indexing/types.ts` — line +33

```diff
30 + export interface AnchorRow {
31 +     parentSymbolKey: string;
32 +     kind: string;
33 +     line: number;               // 0-based line index
```

AnchorRow.line is documented as 0-based, but extractParsedFile persists anchors as 1-based (a.line + 1) and TOON’s compressFile expects 1-based across the seam. The type comment should match the persisted/unit contract.

### Comment #67

**copilot-pull-request-reviewer [AI]** reviewed · 2026-06-15 16:02:52 UTC

## Pull request overview

Copilot reviewed 66 out of 67 changed files in this pull request and generated 6 comments.

### Comment #68

**Copilot [AI]** reviewed · 2026-06-15 16:02:52 UTC

`packages/zenith-mcp/src/core/indexing/extract.ts` — lines +148 to +150

```diff
147 +             for (const a of defAnchors) {
148 +                 // a.line is 0-based (anchors.ts contract). Persist 1-based so every line
149 +                 // column in the DB and across the TOON seam shares one unit — compressFile
150 +                 // consumes `a.line - 1`, which today lands one line HIGH on every anchor.
```

This comment still describes the old anchor unit mismatch ("lands one line HIGH") even though the code now persists anchors as 1-based and TOON converts back via `a.line - 1`. Updating the comment will prevent future confusion/regressions.

### Comment #69

**Copilot [AI]** reviewed · 2026-06-15 16:02:52 UTC

`packages/zenith-mcp/tests/compression-core.test.js` — line +38

```diff
35 +         expect(result.length).toBeLessThan(rawText.length);
36 +         // The 70% floor: result must not be shorter than 70% of rawText
37 +         const floorChars = Math.floor(rawText.length * 0.70);
38 +         expect(result.length).toBeGreaterThanOrEqual(floorChars * 0.5); // TOON may add markers; assert sensible range
```

This test claims to assert the 70% retention floor, but the assertion uses `floorChars * 0.5` (35% of raw), which won’t catch regressions below 70%. Since compressSourceStructured enforces a 70% floor, this can be tightened to the documented contract.

### Comment #70

**Copilot [AI]** reviewed · 2026-06-15 19:58:34 UTC

`packages/zenith-mcp/src/core/indexing/types.ts` — line +16

```diff
13 +     line: number;               // 1-based
14 +     endLine: number;            // 1-based
15 +     column: number;
16 +     bodyHash: string | null;    // sha1 for defs only
```

Comment says bodyHash is SHA-1, but bodyHash() is implemented as SHA-256 (and tests assert 64-hex output). This stale comment can mislead future changes to schema/storage assumptions; update it to SHA-256.

### Comment #71

**Copilot [AI]** reviewed · 2026-06-15 19:58:34 UTC

`packages/zenith-mcp/src/core/indexing/types.ts` — lines +30 to +36

```diff
30 + export interface AnchorRow {
31 +     parentSymbolKey: string;
32 +     kind: string;
33 +     line: number;               // 0-based line index
34 +     priority: number;
35 +     text: string;               // first ~80 chars of the anchor line
36 + }
```

AnchorRow.line is documented as 0-based, but extractParsedFile persists anchors as 1-based (a.line + 1) and zenith-toon compressFile expects 1-based anchors across the seam. Update this comment to match the actual persisted/unit contract.

### Comment #72

**Copilot [AI]** reviewed · 2026-06-15 19:58:34 UTC

`packages/zenith-mcp/src/core/indexing/extract.ts` — lines +148 to +150

```diff
147 +             for (const a of defAnchors) {
148 +                 // a.line is 0-based (anchors.ts contract). Persist 1-based so every line
149 +                 // column in the DB and across the TOON seam shares one unit — compressFile
150 +                 // consumes `a.line - 1`, which today lands one line HIGH on every anchor.
```

This comment says compressFile's `a.line - 1` conversion "today lands one line HIGH on every anchor", but the code now persists anchors as 1-based specifically so TOON can convert back to 0-based correctly. The comment should describe the intentional unit conversion rather than the pre-fix bug.

### Comment #73

**copilot-pull-request-reviewer [AI]** reviewed · 2026-06-15 19:58:35 UTC

## Pull request overview

Copilot reviewed 114 out of 117 changed files in this pull request and generated 4 comments.

### Comment #74

**Copilot [AI]** reviewed · 2026-06-15 19:58:35 UTC

`packages/zenith-mcp/tests/compression-core.test.js` — lines +33 to +38

```diff
33 +         // compressForTool must compress (not return null) and produce a shorter output
34 +         expect(result).not.toBeNull();
35 +         expect(result.length).toBeLessThan(rawText.length);
36 +         // The 70% floor: result must not be shorter than 70% of rawText
37 +         const floorChars = Math.floor(rawText.length * 0.70);
38 +         expect(result.length).toBeGreaterThanOrEqual(floorChars * 0.5); // TOON may add markers; assert sensible range
```

This test claims to verify the 70% retention floor, but the assertion only enforces a 35% lower bound (`floorChars * 0.5`). That makes the test too weak and could miss regressions where TOON compresses below its documented 70% minimum.

### Comment #75

**macroscopeapp [Bot]** reviewed · 2026-06-15 19:59:09 UTC

`packages/zenith-mcp/grammars/queries/lua/locals.scm` — lines +39 to +42

```diff
39 + (chunk
40 +   local_declaration: (function_declaration
41 +     name: (identifier) @local.definition))
42 +
```

🟡 **Medium** `lua/locals.scm:39`

The pattern `(chunk local_declaration: (function_declaration ...))` on line 39 never matches because `chunk` has no `local_declaration` field. In tree-sitter-lua, `local_declaration` is a field on the `declaration` node, not `chunk`. Local function definitions like `local function foo() end` are therefore never captured as `@local.definition`.

```diff
-; Local function is a local definition
-(chunk
-  local_declaration: (function_declaration
-    name: (identifier) @local.definition))
+; Local function is a local definition
+(declaration
+  local_declaration: (function_declaration
+    name: (identifier) @local.definition))
```

### Comment #76

**macroscopeapp [Bot]** reviewed · 2026-06-15 19:59:09 UTC

`packages/zenith-mcp/grammars/queries/lua/locals.scm` — line +33

```diff
42 - (local_variable_declaration
43 -   (variable_list
44 -     (identifier) @local.definition))
33 + (variable_declaration
```

🟡 **Medium** `lua/locals.scm:33`

The `variable_declaration` pattern at lines 33-36 requires an `assignment_statement` child, so it only matches `local x = expr` but not plain `local x` (without initialization). This causes the local variable to not be recognized as a definition, breaking local reference tracking for uninitialized locals.

### Comment #77

**macroscopeapp [Bot]** reviewed · 2026-06-15 20:07:10 UTC

`packages/zenith-mcp/src/scripts/verify-grammar-pins.ts` — lines +35 to +40

```diff
35 +     const manifest = JSON.parse(fs.readFileSync(pinsPath, 'utf-8'));
36 +     const pinned = manifest.pinned as Record<string, {
37 +         sha256: string;
38 +         source: string;
39 +         commit: string;
40 +     }>;
```

🟢 **Low** `scripts/verify-grammar-pins.ts:35`

If `.grammar-pins.json` contains `{}` or `{"pinned": null}`, the script crashes with `TypeError: Cannot convert undefined or null to object` when calling `Object.entries(pinned)` on line 42. The existence check on line 30 doesn't validate that `manifest.pinned` is a non-null object. Consider adding a validation check before the `Object.entries` call.

```diff
-    const manifest = JSON.parse(fs.readFileSync(pinsPath, 'utf-8'));
+    const manifest = JSON.parse(fs.readFileSync(pinsPath, 'utf-8'));
+    if (!manifest.pinned || typeof manifest.pinned !== 'object') {
+        console.log('No grammar pins found (manifest.pinned missing or invalid).');
+        return;
+    }
     const pinned = manifest.pinned as Record<string, {
         sha256: string;
         source: string;
         commit: string;
     }>;
```

### Comment #78

**macroscopeapp [Bot]** reviewed · 2026-06-15 20:07:10 UTC

`packages/zenith-mcp/grammars/queries/scss/locals.scm` — lines +31 to +33

```diff
30 +
31 + ; Else clause body is a scope
32 + (else_clause
33 +   (block) @scope)
```

🟢 **Low** `scss/locals.scm:31`

Variables declared inside `@else if` blocks leak into the parent scope because the scope patterns only cover `if_clause` and `else_clause`, missing `else_if_clause`. Consider adding a pattern for `(else_if_clause (block) @scope)` to ensure proper variable scoping.

```diff
 ; Else clause body is a scope
 (else_clause
   (block) @scope)
+
+; Else-if clause body is a scope
+(else_if_clause
+  (block) @scope)
 
```

---

## Resolved

### Resolved Comment #1

**coderabbitai [Bot]** reviewed · 2026-06-11 07:49:07 UTC

`packages/zenith-mcp/src/core/compression.ts` — lines +51 to +55

```diff
51 +             defs: dbFacts.defs.map(d => ({
52 +                 name: d.name, kind: 'def', type: d.type!,
53 +                 line: d.line, endLine: d.endLine,
54 +                 visibility: d.visibility, captureTag: d.captureTag,
55 +             })),
```

_⚠️ Potential issue_ | _🟠 Major_

**Fix nullable `d.type` handling in `compressForTool` facts mapping**
`packages/zenith-mcp/src/core/db-adapter.ts` defines `FileFacts.defs[].type` as `string | null`, but `packages/zenith-mcp/src/core/compression.ts` maps it with `d.type!`. The `!` doesn’t throw at runtime; it just passes `null` through to the TOON/compression seam, violating the assumed non-null `type: string`. Handle `null` explicitly (filter, default, or adjust the downstream contract) or change the SQL/type to guarantee non-null.

✅ Addressed in commit bef5e9a

### Resolved Comment #2

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/symbol-index.ts` — line +277

```diff
274 +     // Resolve pass: now that all defs across the directory are indexed,
275 +     // resolve unresolved edge targets to their definition sites.
276 +     for (const fp of filePaths) {
277 +         resolveEdgeTargets(db, path.relative(repoRoot, fp));
```

P2: Directory indexing now performs an O(number of files) edge-resolution query sweep even for unchanged files, adding avoidable DB overhead on each run.

✅ Addressed in `bef5e9a`

### Resolved Comment #3

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/compression.ts` — line +52

```diff
49 +             path: validPath,
50 +             langName,
51 +             defs: dbFacts.defs.map(d => ({
52 +                 name: d.name, kind: 'def', type: d.type!,
```

P2: Non-null assertion on `d.type` can pass `null` into TOON despite `type` being required as string.

✅ Addressed in `bef5e9a`

**Suggested changeset 1:** `packages/zenith-mcp/src/core/compression.ts`
```diff
@@ -49,4 +49,4 @@
             path: validPath,
             langName,
             defs: dbFacts.defs.map(d => ({
-                name: d.name, kind: 'def', type: d.type!,
+                name: d.name, kind: 'def', type: d.type ?? 'unknown',
```

### Resolved Comment #4

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/core/indexing/persist.ts` — line +42

```diff
31 +             const key = `${sym.name}:${sym.line}:${sym.column}`;
32 +             keyToId.set(key, rowId);
33 +             if (sym.bodyHash || sym.captureTag || sym.parentSymbolKey || sym.visibility) {
34 +                 const parentId = sym.parentSymbolKey ? (keyToId.get(sym.parentSymbolKey) ?? null) : null;
```

P2: Parent symbol links can be dropped because `parentSymbolId` is resolved before all symbols are inserted.

✅ Addressed in `bef5e9a`

### Resolved Comment #5

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/core/db-adapter.ts` — lines +1224 to +1225

```diff
1222 +  */
1223 + export function getSchemaVersion(conn: DbConnection): number {
1224 +     const row = prepareOrCache(conn, 'SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
1225 +     return row?.version ?? 0;
```

P3: `getSchemaVersion` can throw on fresh DBs because it queries `schema_version` unguarded, so the `?? 0` fallback is not actually reliable.

✅ Addressed in `bef5e9a`

**Suggested changeset 1:** `packages/zenith-mcp/src/core/db-adapter.ts`
```diff
@@ -1221,5 +1221,11 @@ export function execRaw(conn: DbConnection, sql: string): void {
  * SQL: SELECT version FROM schema_version LIMIT 1
  */
 export function getSchemaVersion(conn: DbConnection): number {
-    const row = prepareOrCache(conn, 'SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
-    return row?.version ?? 0;
+    try {
+        const row = prepareOrCache(conn, 'SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
+        return row?.version ?? 0;
+    } catch (error: any) {
+        const msg = error?.message || String(error);
+        if (msg.includes('no such table')) return 0;
+        throw error;
+    }
```

---

## Checks

9 successful · 0 in progress · 0 failed

- ✓ CodeQL — Successful in 3s
- ✓ Socket Security: Pull Request Alerts — Successful in 17s
- ✓ Socket Security: Project Report — Successful in 10s
- ✓ Analyze (javascript-typescript) — Successful in 1m 16s
- ✓ semgrep-cloud-platform/scan — Successful in 3m 46s
- ✓ GitGuardian Security Checks — Successful in 1s
- ✓ cubic · AI code reviewer — Skipped in 1s
- ✓ Macroscope - Correctness Check — Neutral in 9m 50s
- ✓ CodeRabbit — Successful in 0ms

---

**This branch has no conflicts and can be merged.**
