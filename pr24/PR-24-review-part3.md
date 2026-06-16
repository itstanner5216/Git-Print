### Comment #41

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/core/tree-sitter/structure.ts` — line +147

```diff
144 +                 if (c.type === '(' || c.type === ')' || c.type === ',') continue;
145 +                 params.push(c.type);
146 +             }
147 +             return true;
```

P2: Parameter extraction short-circuits after the first container, so symbols can miss type/formal parameter parts when both are present.

### Comment #42

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/core/indexing/persist.ts` — line +73

```diff
62 +         }
63 +         // 9. Local scopes
64 +         for (const local of record.locals) {
65 +             const symbolId = local.parentSymbolKey ? (keyToId.get(local.parentSymbolKey) ?? null) : null;
```

P2: Persisting local scopes with null `symbolId` creates orphaned rows that are never cleaned and accumulate across re-indexes.

### Comment #43

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/core/compression.ts` — line +50

```diff
47 +         maxChars,
48 +         facts: {
49 +             path: validPath,
50 +             langName,
```

P2: Unsupported-language files can no longer be compressed because `langName: null` triggers TOON’s early-return gate before text fallback.

**Suggested changeset 1:** `packages/zenith-mcp/src/core/compression.ts`
```diff
@@ -47,4 +47,4 @@
         maxChars,
         facts: {
             path: validPath,
-            langName,
+            langName: langName ?? 'text',
```

### Comment #44

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/tools/read_multiple_files.ts` — line +145

```diff
145 -
146 -                 if (args.compression !== false) {
147 -                     const compressed = await compressTextFile(validPath, content, effectiveBudget);
145 +                 if (args.compression !== false && bytesRead < byteLimit) {
```

P2: Compression gating has an exact-boundary bug (`bytesRead < byteLimit`) that skips compression for fully-read files whose size equals the read cap.

**Suggested changeset 1:** `packages/zenith-mcp/src/tools/read_multiple_files.ts`
```diff
@@ -142,4 +142,4 @@ export function register(server: ToolServer, ctx: ToolContext) {
 
                 const effectiveBudget = Math.max(0, budget - entryPrefix.length);
 
-                if (args.compression !== false && bytesRead < byteLimit) {
+                if (args.compression !== false && fileInfo.size <= byteLimit) {
```

### Comment #45

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/core/db-adapter.ts` — line +611

```diff
546 +         params.push(kindFilter);
547 +     }
548 +     sql += ' ORDER BY line';
549 +     return handle(conn).prepare(sql).all(...params) as Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }>;
```

P2: `findSymbolsByNameInFile` skips statement caching, adding avoidable prepare overhead on a hot symbol-lookup path.

**Suggested changeset 1:** `packages/zenith-mcp/src/core/db-adapter.ts`
```diff
@@ -608,4 +608,4 @@ export function findStructuralCandidates(
     }
     sql += ' ORDER BY line';
     return handle(conn).prepare(sql).all(...params) as Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }>;
-    return handle(conn).prepare(sql).all(...params) as Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }>;
+    return prepareOrCache(conn, sql).all(...params) as Array<{ name: string; kind: string; type: string; line: number; endLine: number; column: number }>;
```

### Comment #46

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/tests/anchors-pure.test.js` — line +310

```diff
307 +         expect(anchors).toHaveLength(0);
308 +     });
309 +
310 +     it('handles a completely empty language rule table gracefully (scss)', () => {
```

P3: Test name says 'handles a completely empty language rule table' but scss is NOT empty — it has 4 defined rules (if_statement, each_statement, for_statement, while_statement). The test body's own comment acknowledges this ('if_statement IS in the scss rules'), making the name factually misleading. Rename to clarify this tests that scss rules work correctly (e.g. 'handles scss language rules correctly').

### Comment #47

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/tests/anchors-pure.test.js` — line +293

```diff
290 + // ---------------------------------------------------------------------------
291 +
292 + describe('extractAnchorsForDef — boundary cases', () => {
293 +     it('returns empty array for a leaf node (no children)', () => {
```

P3: Test name contradicts the assertion: name says 'returns empty array' but assertion is toBeGreaterThanOrEqual(1). The function correctly emits an anchor when the root node itself matches an anchor rule (return_statement) and its row > defStartRow. The comment within the test body acknowledges this, making the test name misleading. Rename to something like 'emits anchor when leaf def node matches an anchor rule' or 'emits anchor when defNode itself is an anchor type'.

### Comment #48

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/core/indexed-symbols.ts` — line +226

```diff
223 +     return type + 's';
224 + }
225 +
226 + function applyFilters(symbols: IndexedSymbol[], opts: SymbolFilterOptions): IndexedSymbol[] {
```

P3: Duplicated symbol filter/pluralization helpers create avoidable drift risk; shared logic should be centralized.

### Comment #49

**coderabbitai [Bot]** commented · 2026-06-11 10:52:38 UTC

> Unit test generation is a public access feature. Expect some limitations and changes as we gather feedback and continue to improve it.

---

Generating unit tests... This may take up to 20 minutes.

### Comment #50

**coderabbitai [Bot]** commented · 2026-06-11 11:07:44 UTC

Request timed out after 900000ms (requestId=11d66a86-f037-4491-b561-7c50436e0e94)

### Comment #51

**itstanner5216** commented · 2026-06-13 15:47:30 UTC

@macroscope-app review

### Comment #52

**macroscopeapp [Bot]** commented · 2026-06-13 15:49:13 UTC

Code review in progress. Results will be posted as check runs on this PR when complete.

### Comment #53

**macroscopeapp [Bot]** reviewed · 2026-06-13 15:55:59 UTC

`packages/zenith-mcp/src/core/indexed-symbols.ts` — lines +220 to +224

```diff
220 + function pluralize(type: string): string {
221 +     if (type.endsWith('s')) return type + 'es';
222 +     if (type.endsWith('y')) return type.slice(0, -1) + 'ies';
223 +     return type + 's';
224 + }
```

🟢 **Low** `core/indexed-symbols.ts:220`

The `pluralize` function returns `"keies"` for the type `"key"` instead of `"keys"`. The code incorrectly applies the `y → ies` rule to all words ending in `y`, but the rule only applies when `y` is preceded by a consonant. When preceded by a vowel (as in "key"), the correct plural simply adds `s`.

```diff
 function pluralize(type: string): string {
     if (type.endsWith('s')) return type + 'es';
-    if (type.endsWith('y')) return type.slice(0, -1) + 'ies';
+    if (type.endsWith('y') && !/[aeiou]y$/.test(type)) return type.slice(0, -1) + 'ies';
     return type + 's';
 }
```

### Comment #54

**macroscopeapp [Bot]** reviewed · 2026-06-13 15:55:59 UTC

`packages/zenith-toon/src/string-codec.ts` — line +1832

```diff
1829 +   // momentarily stale across an edit boundary). Window clamp.
1830 +   const lineCount = req.source.split('\n').length;
1831 +   const structure: StructureBlock[] = facts.defs
1832 +     .filter((d) => d.line - 1 < lineCount)
```

🟢 **Low** `src/string-codec.ts:1832`

The lower bound check for `d.line` is missing on line 1832, so a def with `line: 0` or negative produces `startLine: -1` after the `-1` conversion. The filter passes bad data through despite the "Public-API hardening" intent. Consider adding `d.line >= 1` to the filter condition.

```diff
-    .filter((d) => d.line - 1 < lineCount)
```

### Comment #55

**macroscopeapp [Bot]** reviewed · 2026-06-13 15:55:59 UTC

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

🟡 **Medium** `indexing/types.ts:30`

`AnchorRow.line` is documented as "0-based line index" but `extract.ts` stores 1-based values (`a.line + 1`). Consumers that trust the interface comment will produce off-by-one errors. Update the comment to "1-based line number" to match the actual persisted values.

**Suggested changeset 1:** `packages/zenith-mcp/src/core/indexing/types.ts`
```diff
@@ -27,10 +27,10 @@
     parentKind: string | null;
 }
 
 export interface AnchorRow {
     parentSymbolKey: string;
     kind: string;
-    line: number;               // 0-based line index
+    line: number;               // 1-based line number
     priority: number;
     text: string;               // first ~80 chars of the anchor line
 }
```

### Comment #56

**macroscopeapp [Bot]** reviewed · 2026-06-13 15:55:59 UTC

`packages/zenith-mcp/src/core/lib.ts` — line +1

🔴 **Critical**

https://github.com/itstanner5216/Zenith-MCP/blob/07d3764e79ae31e6673686c7c3065a5d7efb7011/packages/zenith-mcp/src/core/lib.ts#L128

`validateNewFilePath` resolves the nearest existing ancestor and reconstructs the target path without ever calling `isInsideAllowed`, so paths outside the allowed directories can pass validation if any ancestor directory exists. For example, passing `/etc/malicious.conf` returns successfully even when `/etc` is outside the sandbox. Consider adding `isInsideAllowed(realAncestor)` check and throwing when the ancestor is not allowed.

### Comment #57

**macroscopeapp [Bot]** reviewed · 2026-06-13 15:55:59 UTC

`packages/zenith-mcp/src/core/tree-sitter/locals.ts` — lines +71 to +72

```diff
69 +                     const iStart = innerScope.node.startPosition.row;
70 +                     const iEnd = innerScope.node.endPosition.row;
71 +                     if (row >= iStart && row <= iEnd &&
72 +                         iStart > scopeStartRow && iEnd < scopeEndRow) {
```

🟡 **Medium** `tree-sitter/locals.ts:71`

The nested scope detection at lines 71 and 96 uses strict inequalities (`iEnd < scopeEndRow`) which fails when an inner scope shares a boundary row with its parent. For example, a single-line arrow function ending on the same line as its enclosing function won't be recognized as nested, causing its parameters to be double-counted in both scopes. Consider using `>=`/`<=` for the containment check, or switching to byte-based positions (`startIndex`/`endIndex`) for precise containment.

```diff
-                    if (row >= iStart && row <= iEnd &&
-                        iStart > scopeStartRow && iEnd < scopeEndRow) {
+                    if (row >= iStart && row <= iEnd &&
+                        iStart >= scopeStartRow && iEnd <= scopeEndRow) {
```

### Comment #58

**macroscopeapp [Bot]** reviewed · 2026-06-13 15:55:59 UTC

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

🟡 **Medium** `indexing/extract.ts:169`

The local scope parent assignment (lines 171–176) breaks on the first containing def rather than finding the innermost enclosing one. Since `defs` is sorted by start line (line 85), an outer definition starting earlier will match first — for example, a scope inside a nested function gets assigned to the outer class instead of the enclosing method. This is inconsistent with the `bestSpan` logic used for definitions (lines 100–108) and edges (lines 186–190), which correctly finds the tightest enclosing def.

```diff
        const locals: LocalScopeRow[] = (localScopes ?? []).map(scope => {
-            let parentKey: string | null = null;
-            for (const d of defs) {
-                if (d.line <= scope.startLine && d.endLine >= scope.endLine) {
-                    parentKey = `${d.name}:${d.line}:${d.column}`;
-                    break;
-                }
-            }
-            return { parentSymbolKey: parentKey, scopeKind: scope.scopeKind, startLine: scope.startLine, endLine: scope.endLine, parameters: scope.parameters, locals: scope.locals };
+            let bestParent: SymbolInfo | null = null;
+            let bestSpan = Infinity;
+            for (const d of defs) {
+                if (d.line <= scope.startLine && d.endLine >= scope.endLine) {
+                    const span = d.endLine - d.line;
+                    if (span < bestSpan) { bestSpan = span; bestParent = d; }
+                }
+            }
+            const parentKey = bestParent ? `${bestParent.name}:${bestParent.line}:${bestParent.column}` : null;
+            return { parentSymbolKey: parentKey, scopeKind: scope.scopeKind, startLine: scope.startLine, endLine: scope.endLine, parameters: scope.parameters, locals: scope.locals };
```

### Comment #59

**macroscopeapp [Bot]** commented · 2026-06-13 15:56:32 UTC

#### Approvability

**Verdict:** Needs human review

4 blocking correctness issues found. Diff is too large for automated approval analysis. A human reviewer should evaluate this PR.

You can customize Macroscope's approvability policy. Learn more.

### Comment #60

**cubic-dev-ai [Bot]** reviewed · 2026-06-15 14:23:33 UTC

**2 issues found across 15 files (changes from recent commits).**

Reply with feedback, questions, or to request a fix.

Re-trigger cubic

