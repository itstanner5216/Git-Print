# CI STATUS — PR #70

## ✗ Failed (2)

### ✗ SonarCloud Code Analysis

**`packages/zenith-mcp/src/tools/edit.ts:89`**


See more on https://sonarcloud.io/project/issues?id=itstanner5216_Zenith-MCP&issues=AZ8z8_bKF1Kw6JMcDd0g&open=AZ8z8_bKF1Kw6JMcDd0g&pullRequest=70

```
    79 │         if (l.trim() !== '' && !l.startsWith(newBase)) return newText;
    80 │     }
    81 │     return newLines.map(l => (l.trim() === '' ? l : targetBase + l.slice(newBase.length))).join('\n');
    82 │ }
    83 │ 
    84 │ function normalizeEols(text: string): string {
    85 │     return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    86 │ }
    87 │ 
    88 │ export function register(server: ToolServer, ctx: ToolContext): void {
»   89 │     const handler = async (args: EditArgs) => {
    90 │         const multiEdit = args.edits.length > 1;
    91 │ 
    92 │         // ── Group edits by resolved target file, preserving call order and
    93 │         // global edit indices (so "#N:" matches the caller's array). Distinct
    94 │         // spellings of the same file resolve to one group, keeping every line
    95 │         // number original-file-relative. A sandbox rejection is a per-file
    96 │         // failure, not a call failure.
    97 │         const resolvedByGiven = new Map<string, string | { error: string }>();
    98 │         for (const spec of args.edits) {
    99 │             const given = spec.path ?? args.path;
```

**`packages/zenith-mcp/src/core/symbol-index.ts:501`**


See more on https://sonarcloud.io/project/issues?id=itstanner5216_Zenith-MCP&issues=AZ8z8_a6F1Kw6JMcDd0a&open=AZ8z8_a6F1Kw6JMcDd0a&pullRequest=70

```
   491 │  * replacement as applied, original start line). A future undo tool reverses
   492 │  * the newest patch by content, which survives line drift; the stored
   493 │  * oldText→newText pair is also re-appliable elsewhere without restating
   494 │  * newText. Keying and retention (10 most recent per session/file scope)
   495 │  * live in the db-adapter's snapshotEditVersion. Texts are stored in the
   496 │  * LF-normalized frame the edit tool matches in.
   497 │  */
   498 │ export function snapshotEdit(db: DbConnection, relPath: string, oldText: string, newText: string, line: number, sessionId: string): void {
   499 │     // Length-prefixed framing so (old, new) pairs hash unambiguously - a bare
   500 │     // separator would let ("a|", "b") and ("a", "|b") collide.
»  501 │     const textHash = createHash('md5').update(`${oldText.length}:`).update(oldText).update(newText).digest('hex');
   502 │     snapshotEditVersion(db, {
   503 │         filePath: relPath,
   504 │         oldText,
   505 │         newText,
   506 │         line,
   507 │         sessionId,
   508 │         createdAt: Date.now(),
   509 │         textHash,
   510 │     });
   511 │ }
```

**`packages/zenith-mcp/src/core/db-adapter.ts:95`**


See more on https://sonarcloud.io/project/issues?id=itstanner5216_Zenith-MCP&issues=AZ8z8_arF1Kw6JMcDd0Z&open=AZ8z8_arF1Kw6JMcDd0Z&pullRequest=70

```
    85 │ }
    86 │ 
    87 │ // ---------------------------------------------------------------------------
    88 │ // Schema Initialization
    89 │ // ---------------------------------------------------------------------------
    90 │ 
    91 │ /**
    92 │  * Creates tables: files, symbols, edges, versions, patterns + all indexes for the project symbol database.
    93 │  * Also executes schema migrations in safe try/catch blocks.
    94 │  */
»   95 │ export function initSymbolSchema(conn: DbConnection): void {
    96 │     const db = handle(conn);
    97 │     db.exec(`
    98 │         CREATE TABLE IF NOT EXISTS files (
    99 │             path TEXT PRIMARY KEY,
   100 │             hash TEXT,
   101 │             last_indexed INTEGER
   102 │         );
   103 │         CREATE TABLE IF NOT EXISTS symbols (
   104 │             id INTEGER PRIMARY KEY AUTOINCREMENT,
   105 │             name TEXT,
```


### ✗ SonarQube

_from job log:_

```
10:13:24.689 INFO  Load/download plugins (done) | time=821ms
10:13:24.911 INFO  Loaded core extensions: sca, a3s, architecture
10:13:25.196 INFO  Process project properties
10:13:25.258 ERROR You must define the following mandatory properties for 'Unknown': sonar.projectKey, sonar.organization
10:13:25.584 INFO  EXECUTION FAILURE
10:13:25.584 INFO  Total time: 12.977s
ERROR: Action failed: The process '/opt/hostedtoolcache/sonar-scanner-cli/8.1.0.6389/linux-x64/bin/sonar-scanner' failed with exit code 3
Node 20 is being deprecated. This workflow is running with Node 24 by default. If you need to temporarily use Node 20, you can set the ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true environment variable. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
Post job cleanup.
[command]/usr/bin/git version
```


## ✓ Passed (12)

- ✓ Macroscope - Approvability Check
- ✓ Macroscope - Correctness Check
- ✓ sonarqube-agent
- ✓ copilot
- ✓ semgrep-cloud-platform/scan
- ✓ cubic · AI code reviewer
- ✓ copilot-pull-request-reviewer
- ✓ Socket Security: Pull Request Alerts
- ✓ Build & Test
- ✓ Socket Security: Project Report
- ✓ GitGuardian Security Checks
- ✓ CodeRabbit

## Changed Files (6) — +2005 / -8

**Modified**
- `packages/zenith-mcp/src/core/db-adapter.ts` [+81 | -5]
- `packages/zenith-mcp/src/core/server.ts` [+2]
- `packages/zenith-mcp/src/core/symbol-index.ts` [+31]
- `packages/zenith-mcp/src/core/tree-sitter/symbols.ts` [+9 | -3]

**Added**
- `packages/zenith-mcp/src/tools/edit.ts` [+666]
- `packages/zenith-mcp/tests/edit-tool.test.js` [+1216]


## Commits (6)

1. `4beae08` — Add edit tool: original-relative line edits, forgiving matching, snapshot net
   _itstanner5216 · 2026-07-03 09:23:35 UTC_

2. `444fe4f` — Snapshot the literal patch per edit, not a whole-file copy
   _itstanner5216 · 2026-07-03 09:39:37 UTC_

3. `23f3f9b` — fix(edit): whitespace-reliability hardening — never neutralize an indent fix, symmetric trailing-newline convention, tab↔space tier-4 match
   _itstanner5216 · 2026-07-04 14:04:26 UTC_

4. `f920db9` — fix(edit): resolve verified PR #70 review findings
   _itstanner5216 · 2026-07-08 08:50:39 UTC_

5. `c9981dd` — test(edit): prove opt-in sandbox enforcement against the real FilesystemContext
   _itstanner5216 · 2026-07-08 09:17:33 UTC_

6. `6a02833` — Potential fix for pull request finding
   _itstanner5216 · 2026-07-09 10:12:55 UTC_
