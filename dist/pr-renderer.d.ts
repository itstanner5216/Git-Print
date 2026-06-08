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
}
export interface ResolveOptions {
    gitRoot: string;
    owner: string;
    repo: string;
    pullNumber: number;
    token: string;
    base: string;
    head: string;
    /** Optional immutable SHA pins from the PR metadata. When provided, the
     *  resolver verifies fetched refs match exactly — protecting against the
     *  branches moving between the metadata fetch and the merge. */
    baseSha?: string;
    headSha?: string;
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
    /** Optional pinned base SHA from the PR metadata — when present, we verify. */
    baseSha?: string;
    /** Optional pinned head SHA from the PR metadata — when present, we verify. */
    headSha?: string;
    /** PR number; used to namespace the private refs we fetch into. */
    pullNumber: number;
}
/**
 * Detect conflict regions for the PR by performing a trial merge in an
 * isolated worktree. The worktree is checked out at the base SHA and the
 * head SHA is merged into it, so the resulting markers are in the natural
 * direction for review reporting (ours = base, theirs = head).
 *
 * Note: this differs from the RESOLUTION path, which checks out the head SHA
 * and merges base into it so commits live on the PR's head branch.
 */
export declare function extractConflicts(gitRoot: string, base: string, head: string, prSpec?: PrRefSpec): ConflictFile[];
export declare function renderConflicts(data: PRData, options: PRRendererOptions & {
    gitRoot: string;
}): Promise<string | null>;
export declare function validateInWorktree(gitRoot: string, base: string, head: string, resolutions: Map<string, "baseline" | "incoming">, prSpec?: Pick<ResolveOptions, "baseSha" | "headSha" | "pullNumber">): ValidationResult;
export declare function applyResolutions(opts: ResolveOptions, validation: ValidationResult): ResolveResult;
export declare function resolveConflicts(opts: ResolveOptions): ResolveResult;
export {};
