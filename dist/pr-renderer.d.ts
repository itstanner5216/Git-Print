/**
 * pr-renderer.ts
 *
 * Portable TypeScript module that fetches all data for a GitHub Pull Request
 * and writes two plain-text files:
 *   1. PR-{n}-review.txt  — full conversation/UI mirror
 *   2. PR-{n}-report.txt  — CI/commits/files technical report
 *
 * All shared API data is fetched once via fetchAllPRData() and passed to both renderers.
 */
export interface PRRendererOptions {
    owner: string;
    repo: string;
    pullNumber: number;
    token: string;
    outputPath: string;
    graphqlToken?: string;
    includeResolvedThreads?: boolean;
    fetchCheckAnnotations?: boolean;
    gitRoot?: string;
}
/** Typed subset of the GitHub Pull Request API response — covers every field accessed in this codebase. */
export interface PRMetadata {
    title: string;
    number: number;
    state: string;
    body: string | null;
    author_association: string;
    created_at: string;
    updated_at: string;
    merged: boolean;
    merged_at: string | null;
    merged_by: {
        login: string;
    } | null;
    user: {
        login: string;
        type?: string;
    };
    base: {
        ref: string;
        sha: string;
        label: string;
        repo?: {
            full_name?: string;
            clone_url?: string;
        };
    };
    head: {
        ref: string;
        sha: string;
        label: string;
        repo?: {
            full_name?: string;
            clone_url?: string;
            fork?: boolean;
        };
    };
    mergeable: boolean | null;
    mergeable_state: string;
    changed_files: number;
    additions: number;
    deletions: number;
    requested_reviewers: {
        login: string;
        type?: string;
    }[];
    assignees: {
        login: string;
    }[];
    labels: {
        name: string;
    }[];
    milestone: {
        title: string;
    } | null;
}
export interface PRData {
    pr: PRMetadata;
    commits: any[];
    files: any[];
    checkRuns: any[];
    statuses: any[];
    reviews: any[];
    reviewComments: any[];
    issueComments: any[];
    resolvedThreadMap: ResolvedThreadMap | null;
    unifiedChecks: UnifiedCheck[];
    /** Session-scoped rate limit state — shared across all API calls in one run. */
    rateLimitState: RateLimitState;
}
interface RateLimitState {
    remaining: number;
    resetAt: number;
}
interface ResolvedThreadMap {
    [commentDatabaseId: number]: boolean;
}
interface UnifiedCheck {
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
    detailsUrl: string | null;
    description: string | null;
    checkRunId: number | null;
    source: "check_run" | "status";
}
export interface ConflictRegion {
    startLine: number;
    endLine: number;
    baseContent: string;
    incomingContent: string;
    ancestorContent?: string;
    contextBefore: string[];
    contextAfter: string[];
}
export interface ConflictFile {
    path: string;
    regions: ConflictRegion[];
    oversized: boolean;
    /** Per-result-line side numbers: the real line number of each conflict line
     *  in the clean OURS / THEIRS / BASE blobs. Context lines come from git's
     *  combined diff; conflict-block lines are located structurally inside the
     *  exact local blobs (so shared lines never tangle and BASE is numbered).
     *  Optional: absent → renderer falls back to merged-file line numbers. */
    sideMap?: SideLineMap;
}
/** result-line (1-based) → real per-side file line numbers. */
export type SideLineMap = Map<number, {
    ours: number | null;
    theirs: number | null;
    base: number | null;
}>;
export interface ResolveOptions {
    gitRoot: string;
    owner: string;
    repo: string;
    pullNumber: number;
    token: string;
    base: string;
    head: string;
    resolutions: Map<string, "baseline" | "incoming">;
}
/** Index-state fingerprint — git's content-addressable oid + mode for a kept
 *  file, or "deleted" when the chosen side removed it. Handles binaries,
 *  symlinks, executable bit, and submodules natively (which raw file-byte
 *  hashing does not). */
export interface IndexFingerprint {
    kind: "blob" | "deleted";
    oid?: string;
    mode?: string;
}
export interface ResolvedFile {
    path: string;
    side: "baseline" | "incoming";
    fingerprint: IndexFingerprint;
}
export interface ValidationResult {
    status: "validated" | "failed";
    conflictFiles: string[];
    resolutionPlan: ResolvedFile[];
    skipped: string[];
    warnings: string[];
    error?: string;
}
export interface ResolveResult {
    /** "committed" → resolution applied & committed in the user's working tree;
     *  "partial"   → some conflicts resolved, merge left in progress for the rest;
     *  "no_conflicts" → merge was clean after all;
     *  "aborted"   → something went wrong, working tree left unchanged. */
    status: "committed" | "partial" | "no_conflicts" | "aborted";
    resolved?: {
        file: string;
        side: string;
    }[];
    skipped?: string[];
    warnings?: string[];
    commitMessage?: string;
    /** SHA of the new commit on the user's current branch (status === "committed"). */
    commitSha?: string;
    /** Hint for the user about which remote/branch to push. */
    pushHint?: {
        branch: string;
    };
    error?: string;
}
export declare function apiFetch(path: string, token: string, rl?: RateLimitState): Promise<any>;
export declare function fetchAllPages<T = any>(path: string, token: string, rl?: RateLimitState): Promise<T[]>;
/**
 * Lightweight fetch — just the PR metadata (single API call + mergeable polling).
 * Use this when you only need branch names and merge status (e.g. resolve mode).
 */
export declare function fetchPRMetadata(owner: string, repo: string, pullNumber: number, token: string): Promise<PRMetadata>;
/**
 * Fetch all shared PR data in one shot. Called once per run.
 * Both renderPR() and renderReport() consume this without making their own API calls
 * (except renderReport's deferred annotation/file-content fetches for failed checks).
 */
export declare function fetchAllPRData(owner: string, repo: string, pullNumber: number, token: string, graphqlToken?: string): Promise<PRData>;
/**
 * Copilot / bot code-review "suggested change" changesets are not carried by any
 * REST or GraphQL field (github/github-mcp-server#2235): git-print's API-only
 * fetch silently drops every one. The PR *web page* inlines each changeset as
 * JSON inside a `react-partial.embeddedData` <script>, at
 * `props.comment.automatedComment.suggestion.diffEntries`. Resolved / outdated
 * (collapsed) threads are NOT server-rendered into the page — their changesets
 * live behind `data-deferred-content-url="/…/threads/{id}"` fragments that must
 * be fetched separately.
 *
 * This recovers BOTH: fetch the page, recursively collect every
 * `automatedComment.suggestion.diffEntries` keyed by the comment's `databaseId`,
 * then fetch each deferred `/threads/…` fragment and repeat. Each recovered
 * changeset is attached to the matching review comment (`comment.id` ===
 * page `databaseId`) as `automated_suggestions`, so writeThreadMd can render it
 * exactly like a body-borne ```suggestion changeset — resolved ones landing in
 * the existing "## Resolved" section since those threads already route there.
 *
 * Best-effort by design: NO Authorization header is sent to github.com, and any
 * fetch/parse failure attaches nothing and leaves today's render untouched.
 */
export declare function attachAutomatedSuggestions(prHtmlUrl: string | undefined, reviewComments: any[]): Promise<void>;
/**
 * Strip the promotional / UI cruft bots inject into comment bodies so the
 * printout reads like clean prose: HTML comments, badge/mascot images,
 * social-share link lists, and CodeRabbit's "Tips"/"Share" <details> footers.
 *
 * Content policy (the contract this function serves):
 *   KEEP  — every word a reader sees on the PR page: prose (byte-faithful,
 *           never escaped or reflowed), link TEXT, bare URLs the author typed,
 *           file paths, identifiers, fenced code and diff material (untouched).
 *   DROP  — web furniture only: link TARGETS, angle autolinks `<https://…>`
 *           produced by the page→markdown translation, images entirely,
 *           HTML comments, collapsed bot boilerplate, share/promo/status
 *           lines, and whole comments that are nothing but promotion.
 */
export declare function cleanCommentBody(raw: string, findingHeader?: string): string;
export declare function renderPR(data: PRData, options: PRRendererOptions): Promise<void>;
export declare function renderReport(data: PRData, options: PRRendererOptions): Promise<void>;
/**
 * Resolve the common Git directory for the repository containing `gitRoot`.
 * Crucially this returns the SHARED admin dir even when `gitRoot` is a linked
 * worktree where `<root>/.git` is a file (a gitfile pointer), not a directory.
 *
 * Use this anywhere code might write under the admin store (reports, scratch
 * worktrees, etc.) — never assume `<root>/.git` is a usable directory.
 */
export declare function gitCommonDir(gitRoot: string): string;
interface PrRefSpec {
    /** PR number; used to namespace the private refs we fetch into. */
    pullNumber: number;
}
/**
 * Parse a git *combined* diff (the `@@@ -ours -theirs +result @@@` form git
 * emits for a conflicted / merge file) into a per-result-line side-number map:
 * `resultLine → { ours, theirs }`. A line present in a side carries that side's
 * real file line number; lines absent from a side (conflict markers, the zdiff3
 * BASE block, the OTHER side's content) carry `null` there. This is the local,
 * git-computed source of per-side conflict line numbers — no GitHub API.
 *
 * Two-parent combined diff only (ours = parent1 / column 1, theirs = parent2 /
 * column 2) — exactly what a 2-way merge (base↔head) produces. Octopus merges
 * (≥3 parents) don't match the header and yield an empty map (→ caller falls
 * back to merged-file numbers).
 */
export declare function parseCombinedDiffSideMap(diffText: string): Map<number, {
    ours: number | null;
    theirs: number | null;
}>;
/** Split a git blob/file into lines WITHOUT a phantom trailing element, so line
 *  counts match git's own (a terminal "\n" does not add a line). */
export declare function splitGitLines(text: string): string[];
/** Read a git object (`<rev>:<path>`, `:N:<path>` stage blob, …) as lines.
 *  No trimming — exact line counts matter. undefined when the object is absent
 *  (e.g. a missing stage in an add/add, rename, or delete/modify conflict). */
export declare function readBlobLines(cwd: string, spec: string): string[] | undefined;
/**
 * Build the unified per-result-line side map for one conflicted file.
 *
 * Context lines (outside the markers) take their ours/theirs numbers from git's
 * combined diff — reliable there, and the cheapest source. Conflict-block lines
 * are numbered STRUCTURALLY: each ours/theirs/base block is content-located in
 * its own clean blob and counted sequentially from the located start. Because
 * the three sides are located in three separate blobs, shared lines can never
 * cross-tangle (the combined-diff failure mode), and BASE — which has no column
 * in a combined diff at all — is numbered like any other side.
 */
export declare function buildSideLineMap(mergedContent: string, combined: Map<number, {
    ours: number | null;
    theirs: number | null;
}> | undefined, blobs: {
    ours?: string[];
    base?: string[];
    theirs?: string[];
}): SideLineMap;
/**
 * Detect conflict regions for the PR via an in-memory trial merge.
 *
 * Uses `git merge-tree --write-tree` (git ≥2.38): a real merge performed
 * entirely in the object database — no worktree, no checkout, nothing written
 * to the working tree, nothing to clean up. The merge is run base-first
 * (`merge-tree base head`) so the resulting markers read ours = base,
 * theirs = head — the natural direction for review reporting. The merged
 * blobs (read back with `git show <tree>:<path>`) carry the conflict markers,
 * honoring the user's merge.conflictStyle (incl. zdiff3), and feed the same
 * parseConflictMarkers() used everywhere else.
 *
 * Note: this differs from the RESOLUTION path, which must use a real worktree
 * because it writes commits onto the PR's head branch.
 */
export declare function extractConflicts(gitRoot: string, base: string, head: string, prSpec?: PrRefSpec): ConflictFile[];
export declare function renderConflicts(data: PRData, options: PRRendererOptions & {
    gitRoot: string;
}): Promise<string | null>;
export declare function validateInWorktree(gitRoot: string, base: string, head: string, resolutions: Map<string, "baseline" | "incoming">, prSpec?: Pick<ResolveOptions, "pullNumber">): ValidationResult;
export declare function applyResolutions(opts: ResolveOptions, validation: ValidationResult): ResolveResult;
export declare function resolveConflicts(opts: ResolveOptions): ResolveResult;
export {};
