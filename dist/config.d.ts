/**
 * config.ts — Git-Print plain-text config
 *
 * Config file location: ~/.config/git-print/config
 *
 * Format (Zenith-inspired):
 *
 *   # Git-Print Configuration
 *
 *   ## Repos
 *   zenith-mcp: /home/tanner/Projects/Zenith-MCP
 *   git-print: /home/tanner/Projects/Git-Print
 *
 *   ## Worktrees
 *   zenith-mcp/pr23-test: /home/tanner/Projects/Zenith-Worktrees/pr23-pr20-merge-test
 *
 *   ## Settings
 *   auto-discover-worktrees: enabled
 *
 * Commands:
 *   git-print add <alias> [path]         — register a repo (auto-detect path if omitted)
 *   git-print add <alias>/<wt> [path]    — register a worktree
 *   git-print list                        — show all registered repos + worktrees
 *   git-print remove <alias>             — remove a repo + its worktrees
 *   git-print remove <alias>/<wt>        — remove a single worktree
 */
export declare function configPath(): string;
export declare function detectRepoRoot(fromDir?: string): string | null;
/** Add or update a repo alias. */
export declare function addRepo(alias: string, repoPath?: string): void;
/** Add or update a worktree alias. Key format: "alias/worktree-name". */
export declare function addWorktree(alias: string, worktreeName: string, wtPath?: string): void;
/** Remove a repo and all its worktrees, or just a single worktree. */
export declare function remove(target: string): void;
/** Resolve --repo [--worktree] into an absolute directory path. */
export declare function resolve(alias: string, worktreeName?: string): string;
/** Return all registered repos as {alias, path} pairs (top-level repos only). */
export declare function getRepos(): {
    alias: string;
    path: string;
}[];
/** Print a human-readable list of all registered repos + worktrees. */
export declare function list(): void;
