### Comment #21

**coderabbitai [Bot]** reviewed · 2026-06-11 07:49:07 UTC

`packages/zenith-mcp/src/core/tree-sitter/anchors.ts` — lines +11 to +16

```diff
11 + export interface AnchorEntry {
12 +     line: number;         // 0-based line index
13 +     endLine: number;      // 0-based
14 +     kind: string;
15 +     priority: number;
16 + }
```

_⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

**Anchor line numbers contradict PR objective's "1-based end-to-end" claim.**

The interface comments (lines 12-13) document `line` and `endLine` as `0-based`, and the implementation returns raw `node.startPosition.row` (0-based tree-sitter coordinates) without converting to 1-based. However, the PR objectives explicitly state: *"anchor unit mismatch (now 1-based end-to-end and priority by kind)"*.

If the DB schema, compression, and downstream consumers expect 1-based coordinates as documented in the PR summary, anchors will be placed one line too early.

Also applies to: 240-245

### Comment #22

**coderabbitai [Bot]** reviewed · 2026-06-11 07:49:07 UTC

`packages/zenith-mcp/src/core/tree-sitter/locals.ts` — lines +62 to +85

```diff
62 +         for (const p of params) {
63 +             const row = p.node.startPosition.row;
64 +             if (row >= scopeStartRow && row <= scopeEndRow) {
65 +                 // Check that this param is directly in THIS scope (not a nested one)
66 +                 let directChild = true;
67 +                 for (const innerScope of scopes) {
68 +                     if (innerScope === scope) continue;
69 +                     const iStart = innerScope.node.startPosition.row;
70 +                     const iEnd = innerScope.node.endPosition.row;
71 +                     if (row >= iStart && row <= iEnd &&
72 +                         iStart > scopeStartRow && iEnd < scopeEndRow) {
73 +                         directChild = false;
74 +                         break;
75 +                     }
76 +                 }
77 +                 if (directChild) {
78 +                     scopeParams.push({
79 +                         name: p.node.text,
80 +                         line: row + 1,
81 +                         column: p.node.startPosition.column,
82 +                     });
83 +                 }
84 +             }
85 +         }
```

_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Nested scope detection fails when inner and outer scopes end on the same row.**

The condition at line 72 uses strict `<`:
```typescript
iStart > scopeStartRow && iEnd < scopeEndRow
```

When a nested scope ends on the same row as its parent (e.g., closing braces aligned), `iEnd < scopeEndRow` evaluates to false, so the parameter is incorrectly classified as a direct child of the outer scope.

Example:
```
outer: rows 1-10
inner: rows 3-10
param:  row 5
```
Condition: `3 > 1 && 10 < 10` → false → param assigned to outer, not inner.

### Comment #23

**coderabbitai [Bot]** reviewed · 2026-06-11 07:49:08 UTC

`packages/zenith-mcp/src/core/tree-sitter/locals.ts` — lines +87 to +110

```diff
 87 +         const scopeDefs: LocalSymbol[] = [];
 88 +         for (const d of defs) {
 89 +             const row = d.node.startPosition.row;
 90 +             if (row >= scopeStartRow && row <= scopeEndRow) {
 91 +                 let directChild = true;
 92 +                 for (const innerScope of scopes) {
 93 +                     if (innerScope === scope) continue;
 94 +                     const iStart = innerScope.node.startPosition.row;
 95 +                     const iEnd = innerScope.node.endPosition.row;
 96 +                     if (row >= iStart && row <= iEnd &&
 97 +                         iStart > scopeStartRow && iEnd < scopeEndRow) {
 98 +                         directChild = false;
 99 +                         break;
100 +                     }
101 +                 }
102 +                 if (directChild) {
103 +                     scopeDefs.push({
104 +                         name: d.node.text,
105 +                         line: row + 1,
106 +                         column: d.node.startPosition.column,
107 +                     });
108 +                 }
109 +             }
110 +         }
```

_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Same nested scope boundary issue for local definitions.**

Duplicate of the parameter extraction issue: strict `<` at line 97 fails to detect nested scopes when `iEnd === scopeEndRow`.

### Comment #24

**coderabbitai [Bot]** reviewed · 2026-06-11 07:49:08 UTC

`packages/zenith-mcp/tests/compression-core.test.js` — lines +36 to +39

```diff
36 +         // The 70% floor: result must not be shorter than 70% of rawText
37 +         const floorChars = Math.floor(rawText.length * 0.70);
38 +         expect(result.length).toBeGreaterThanOrEqual(floorChars * 0.5); // TOON may add markers; assert sensible range
39 +     });
```

_⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**Test assertion is looser than documented contract.**

The assertion checks that result length is at least `floorChars * 0.5`:
```javascript
const floorChars = Math.floor(rawText.length * 0.70);
expect(result.length).toBeGreaterThanOrEqual(floorChars * 0.5);
```

This effectively asserts `result.length >= 0.35 * rawText.length`, but the 70% retention floor documented in TOON means output should be `>= 0.70 * rawText.length`. The `* 0.5` multiplier undercuts the contract.

If TOON markers genuinely add significant overhead that could push the output below 70%, the test comment should explain that; otherwise, tighten the assertion to match the documented floor.

### Comment #25

**coderabbitai [Bot]** reviewed · 2026-06-11 07:49:08 UTC

`packages/zenith-mcp/tests/compression-seam.test.js` — lines +35 to +49

```diff
35 + // Tokens that must not appear anywhere in compression.ts. Each name is a
36 + // compression decision owned by TOON; any reappearance here means MCP has
37 + // taken back ownership of something the seam handed away.
38 + const FORBIDDEN_COMPRESSION_TOKENS = [
39 +     'computeCompressionBudget',
40 +     'isCompressionUseful',
41 +     'DEFAULT_COMPRESSION_KEEP_RATIO',
42 +     'truncateToBudget',
43 +     'compressTextFile',
44 +     'compressSourceStructured',
45 +     'compressString',
46 +     'keepRatio',
47 +     'StructureBlock',
48 +     'Math.sqrt',
49 + ];
```

_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Seam invariant test currently enforces a contract that contradicts the repo’s compression guidelines.**

This forbidden-token list blocks `isCompressionUseful`/budget-flow symbols that the guidelines explicitly require in `packages/zenith-mcp/src/core/compression.ts`. As written, this test can reject compliant implementations and force regressions to satisfy the test.

As per coding guidelines, “Compression flow: … `compressTextFile()` computes budget (`DEFAULT_COMPRESSION_KEEP_RATIO = 0.70`) … caller accepts compressed output only if useful (`isCompressionUseful()`).”

Also applies to: 52-65

_Source: Coding guidelines_

### Comment #26

**coderabbitai [Bot]** reviewed · 2026-06-11 07:49:08 UTC

`packages/zenith-mcp/tests/db-adapter-v1-tables.test.js` — lines +77 to +87

```diff
77 +     it('returns 0 on a fresh memory db without init', () => {
78 +         const db = openMemoryDb();
79 +         // schema_version table doesn't exist — prepareOrCache will throw,
80 +         // so we expect getSchemaVersion to either return 0 or throw;
81 +         // after initSymbolSchema it must be 1.
82 +         // Just verify the 1-after-init invariant here via makeDb():
83 +         closeDb(db);
84 +         const db2 = makeDb();
85 +         expect(getSchemaVersion(db2)).toBe(1);
86 +         closeDb(db2);
87 +     });
```

_⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**`getSchemaVersion` fresh-DB case is not actually tested.**

Line 78 creates a fresh DB, but `getSchemaVersion(db)` is never called before closing it. This test currently passes without validating the behavior named in the test title.

### Comment #27

**coderabbitai [Bot]** requested changes · 2026-06-11 07:49:10 UTC

**Actionable comments posted: 9**

> Some comments are outside the diff and can’t be posted inline due to platform limitations.

### Comment #28

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:24 UTC

**24 issues found** across 52 files

Reply with feedback, questions, or to request a fix.

Re-trigger cubic

### Comment #29

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/tree-sitter/structure.ts` — line +139

```diff
136 +     // --- Params ---
137 +     const params: string[] = [];
138 +     function collectParams(node: Node, isRoot: boolean): boolean {
139 +         if (!isRoot && DEF_TYPES.has(node.type)) return false;
```

P1: Decorated definitions lose structural extraction because recursion blocks the wrapped function/class node.

### Comment #30

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/lib.ts` — line +72

```diff
69           try {
70               const realPath = await fs.realpath(absolute);
71               normalizePath(realPath);
72 +             if (!(await isInsideAllowed(realPath))) {
```

P1: Allowlist enforcement was added to `validatePath` but not to `validateNewFilePath`, allowing writes outside allowed directories via `write_file`.

### Comment #31

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/tree-sitter/imports.ts` — line +36

```diff
33 +
34 +     const imports: ImportEdge[] = [];
35 +     for (const [line, refs] of byLine) {
36 +         const moduleRef = refs.find(r => r.type === 'module');
```

P1: Multi-line import statements produce fragmented/wrong import edges. The function groups `module` and `import` refs by `ref.line`, but for multi-line imports (e.g. `import { readFile, writeFile } from 'fs'` spanning 3 lines), each imported name lands on a different line and gets its own `ImportEdge`. Lines that only have `import`-type refs (no `module`-type ref) fall back to using `importRefs[0]!.name` as the `module` field — producing semantically incorrect data where the first imported name is misattributed as the module source.

### Comment #32

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/tree-sitter/locals.ts` — line +72

```diff
69 +                     const iStart = innerScope.node.startPosition.row;
70 +                     const iEnd = innerScope.node.endPosition.row;
71 +                     if (row >= iStart && row <= iEnd &&
72 +                         iStart > scopeStartRow && iEnd < scopeEndRow) {
```

P2: Row-only containment with strict inner-scope bounds misassigns nested locals to outer scopes when scopes share start/end rows.

### Comment #33

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/tree-sitter/body.ts` — line +17

```diff
14 +  * @param endLine   1-based inclusive end
15 +  */
16 + export function bodySlice(source: string, startLine: number, endLine: number): string {
17 +     const lines = source.split('\n');
```

P2: `source.split('\n')` does not handle `\r\n` (CRLF) line endings, leaving trailing `\r` characters on each line when source text originates from Windows or mixed-line-ending files. This causes incorrect body slices and hash mismatches between systems — a silent correctness bug for the change-detection/dedup function this module's fingerprinting is designed for.

### Comment #34

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/indexing/extract.ts` — line +174

```diff
171 +             for (const d of defs) {
172 +                 if (d.line <= scope.startLine && d.endLine >= scope.endLine) {
173 +                     parentKey = `${d.name}:${d.line}:${d.column}`;
174 +                     break;
```

P2: Local scopes can be attached to the wrong (outer) definition because parent selection breaks on first containment match instead of choosing the innermost enclosing def.

### Comment #35

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/indexing/types.ts` — line +33

```diff
30 + export interface AnchorRow {
31 +     parentSymbolKey: string;
32 +     kind: string;
33 +     line: number;               // 0-based line index
```

P2: AnchorRow.line comment says "0-based line index" but the extractor always stores 1-based values — stale/wrong comment that will cause off-by-one bugs for anyone cross-referencing anchor lines with other rows.

### Comment #36

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/tools/directory.ts` — line +207

```diff
205                                   return [entry.name, null, null];
206                               const names = symbols.slice(0, 50).map(s => `${s.name} (${s.type})`);
202 -                             const summary = await getFileSymbolSummary(fullPath);
207 +                             const summary = await loadFileSymbolSummary(fullPath);
```

P2: Directory symbol summaries now index and parse large files with no size cap, which can significantly degrade tree listing performance.

### Comment #37

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/tests/db-adapter-v1-tables.test.js` — line +77

```diff
74 +         closeDb(db);
75 +     });
76 +
77 +     it('returns 0 on a fresh memory db without init', () => {
```

P2: Test 'returns 0 on a fresh memory db without init' does not test what its name describes. It opens an uninitialized db, closes it without asserting anything, then tests an initialized db instead. The test body is misleading and the scenario described in the name/comment is never actually verified.

### Comment #38

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:25 UTC

`packages/zenith-mcp/src/core/indexed-symbols.ts` — line +177

```diff
174 +     // (rather than `{ ...opts, kindFilter: undefined }`) keeps us
175 +     // compatible with `exactOptionalPropertyTypes: true`.
176 +     const { kindFilter: _unusedKindFilter, ...restOpts } = opts;
177 +     return applyFilters(matches, restOpts);
```

P2: `loadSymbolInFile` incorrectly reapplies `nameFilter`, which can hide valid exact symbol matches and break `findSymbol()` compatibility.

### Comment #39

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/tools/refactor_batch.ts` — line +985

```diff
974 -             const structs: (SymbolStructure | null)[] = [];
975 -             // TODO: Populate actual SymbolStructure from AST for each target
984 +             const structs: (SymbolStructure | null)[] = targets.map(t => {
985 +                 const matches = findSymbolStructuresByName(db, t.symbol);
```

P2: Reapply does N+1 symbol-structure queries by re-fetching the same symbol rows per target, which can significantly slow large batches.

### Comment #40

**cubic-dev-ai [Bot]** reviewed · 2026-06-11 07:52:26 UTC

`packages/zenith-mcp/src/core/tree-sitter/anchors.ts` — line +228

```diff
225 +     if (!rules) return [];
226 +
227 +     const anchors: AnchorEntry[] = [];
228 +     const DEF_NODE_TYPES = new Set([
```

P2: Nested-definition pruning is incomplete: the local DEF_NODE_TYPES list omits many definition node types, so anchors from inner definitions can leak into outer symbol anchors.

