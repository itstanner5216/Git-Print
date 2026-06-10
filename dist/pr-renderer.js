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
import { writeFile, unlink } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, basename, extname } from "node:path";
// ─── API helpers ─────────────────────────────────────────────────────────────
const API_BASE = "https://api.github.com";
function createRateLimitState() {
    return { remaining: 5000, resetAt: 0 };
}
function updateRateLimit(headers, rl) {
    const rem = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (rem !== null)
        rl.remaining = parseInt(rem, 10);
    if (reset !== null)
        rl.resetAt = parseInt(reset, 10);
}
async function waitForRateLimit(rl) {
    if (rl.remaining < 10) {
        const now = Math.floor(Date.now() / 1000);
        const waitSec = Math.max(0, rl.resetAt - now) + 1;
        console.warn(`Rate limit low (${rl.remaining} remaining). Waiting ${waitSec}s...`);
        await sleep(waitSec * 1000);
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export async function apiFetch(path, token, rl = createRateLimitState()) {
    await waitForRateLimit(rl);
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token)
        headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    updateRateLimit(res.headers, rl);
    if (!res.ok) {
        throw new Error(`GitHub API ${res.status} ${res.statusText}: ${url}`);
    }
    return res.json();
}
export async function fetchAllPages(path, token, rl = createRateLimitState()) {
    const items = [];
    let url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const separator = url.includes("?") ? "&" : "?";
    if (!url.includes("per_page"))
        url += `${separator}per_page=100`;
    const pageHeaders = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token)
        pageHeaders.Authorization = `Bearer ${token}`;
    while (url) {
        await waitForRateLimit(rl);
        const res = await fetch(url, { headers: pageHeaders });
        updateRateLimit(res.headers, rl);
        if (!res.ok) {
            throw new Error(`GitHub API ${res.status}: ${url}`);
        }
        const data = await res.json();
        if (Array.isArray(data)) {
            items.push(...data);
        }
        else if (data && typeof data === "object") {
            // GitHub wraps some list endpoints in an object
            if (Array.isArray(data.check_runs)) {
                items.push(...data.check_runs);
            }
            else if (Array.isArray(data.statuses)) {
                items.push(...data.statuses);
            }
            else {
                const keys = Object.keys(data).join(", ");
                console.warn(`Warning: fetchAllPages got unexpected response shape from ${url}. Top-level keys: [${keys}]. Expected array or {check_runs|statuses: [...]}. Page skipped.`);
            }
        }
        else {
            console.warn(`Warning: fetchAllPages got non-object response from ${url}: ${typeof data}. Page skipped.`);
        }
        const link = res.headers.get("link");
        url = null;
        if (link) {
            const match = link.match(/<([^>]+)>;\s*rel="next"/);
            if (match)
                url = match[1];
        }
    }
    return items;
}
async function graphqlFetch(query, variables, token, rl = createRateLimitState()) {
    await waitForRateLimit(rl);
    const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
    });
    updateRateLimit(res.headers, rl);
    if (!res.ok) {
        throw new Error(`GraphQL ${res.status}: ${res.statusText}`);
    }
    return res.json();
}
// ─── Shared data fetcher ─────────────────────────────────────────────────────
async function fetchPRWithMergeable(owner, repo, pr, token, rl) {
    const path = `/repos/${owner}/${repo}/pulls/${pr}`;
    let data = await apiFetch(path, token, rl);
    let attempts = 0;
    while (data.mergeable === null && attempts < 10) {
        await sleep(2000);
        data = await apiFetch(path, token, rl);
        attempts++;
    }
    return data;
}
/**
 * Lightweight fetch — just the PR metadata (single API call + mergeable polling).
 * Use this when you only need branch names and merge status (e.g. resolve mode).
 */
export async function fetchPRMetadata(owner, repo, pullNumber, token) {
    const rl = createRateLimitState();
    console.error(`Fetching PR #${pullNumber} metadata from ${owner}/${repo}...`);
    return fetchPRWithMergeable(owner, repo, pullNumber, token, rl);
}
async function fetchResolvedThreads(owner, repo, pr, token, rl) {
    const map = {};
    const query = `
    query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isResolved
              comments(first: 1) {
                nodes { id databaseId }
              }
            }
          }
        }
      }
    }
  `;
    let cursor = null;
    let hasNext = true;
    while (hasNext) {
        const result = await graphqlFetch(query, { owner, repo, pr, cursor }, token, rl);
        const threads = result.data?.repository?.pullRequest?.reviewThreads;
        if (!threads)
            break;
        for (const thread of threads.nodes) {
            const firstComment = thread.comments?.nodes?.[0];
            if (firstComment) {
                map[firstComment.databaseId] = thread.isResolved;
            }
        }
        hasNext = threads.pageInfo.hasNextPage;
        cursor = threads.pageInfo.endCursor;
    }
    return map;
}
function mergeChecksAndStatuses(checkRuns, statuses) {
    const byName = new Map();
    for (const cr of checkRuns) {
        byName.set(cr.name, {
            name: cr.name,
            status: cr.status,
            conclusion: cr.conclusion,
            startedAt: cr.started_at,
            completedAt: cr.completed_at,
            detailsUrl: cr.details_url || cr.html_url,
            description: cr.output?.summary || cr.output?.title || null,
            checkRunId: cr.id,
            source: "check_run",
        });
    }
    // Deduplicate statuses by context, keep latest
    const latestStatuses = new Map();
    for (const st of statuses) {
        const ctx = st.context || st.description || "Unknown";
        const existing = latestStatuses.get(ctx);
        if (!existing || new Date(st.updated_at).getTime() > new Date(existing.updated_at).getTime()) {
            latestStatuses.set(ctx, st);
        }
    }
    for (const [ctx, st] of latestStatuses) {
        if (!byName.has(ctx)) {
            byName.set(ctx, {
                name: ctx,
                status: st.state === "pending" ? "in_progress" : "completed",
                conclusion: st.state === "pending" ? null : st.state,
                startedAt: st.created_at,
                completedAt: st.updated_at,
                detailsUrl: st.target_url,
                description: st.description,
                checkRunId: null,
                source: "status",
            });
        }
    }
    return Array.from(byName.values());
}
/**
 * Fetch all shared PR data in one shot. Called once per run.
 * Both renderPR() and renderReport() consume this without making their own API calls
 * (except renderReport's deferred annotation/file-content fetches for failed checks).
 */
export async function fetchAllPRData(owner, repo, pullNumber, token, graphqlToken) {
    const rl = createRateLimitState();
    const base = `/repos/${owner}/${repo}`;
    const prPath = `${base}/pulls/${pullNumber}`;
    console.error(`Fetching PR #${pullNumber} from ${owner}/${repo}...`);
    // Phase 1: parallel fetch everything except checks (need headSha)
    const [pr, commits, reviews, reviewComments, issueComments, files] = await Promise.all([
        fetchPRWithMergeable(owner, repo, pullNumber, token, rl),
        fetchAllPages(`${prPath}/commits`, token, rl),
        fetchAllPages(`${prPath}/reviews`, token, rl),
        fetchAllPages(`${prPath}/comments`, token, rl),
        fetchAllPages(`${base}/issues/${pullNumber}/comments`, token, rl),
        fetchAllPages(`${prPath}/files`, token, rl),
    ]);
    const headSha = pr.head.sha;
    // Phase 2: checks + statuses (need headSha) + GraphQL resolved threads
    const fetchPromises = [
        fetchAllPages(`${base}/commits/${headSha}/check-runs`, token, rl),
        fetchAllPages(`${base}/commits/${headSha}/statuses`, token, rl),
    ];
    let resolvedThreadMap = null;
    if (graphqlToken) {
        fetchPromises.push(fetchResolvedThreads(owner, repo, pullNumber, graphqlToken, rl).catch((e) => {
            console.warn(`Warning: Could not fetch resolved threads via GraphQL: ${e.message}`);
            return null;
        }));
    }
    const phase2 = await Promise.all(fetchPromises);
    const checkRuns = phase2[0];
    const statuses = phase2[1];
    if (graphqlToken) {
        resolvedThreadMap = phase2[2];
    }
    const unifiedChecks = mergeChecksAndStatuses(checkRuns, statuses);
    console.error(`Fetched: ${commits.length} commits, ${reviews.length} reviews, ${reviewComments.length} review comments, ${issueComments.length} issue comments, ${files.length} files, ${unifiedChecks.length} checks`);
    return {
        pr,
        commits,
        files,
        checkRuns,
        statuses,
        reviews,
        reviewComments,
        issueComments,
        resolvedThreadMap,
        unifiedChecks,
        rateLimitState: rl,
    };
}
// ─── Formatting helpers ──────────────────────────────────────────────────────
function formatDate(iso) {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
function formatAssociation(assoc, user) {
    if (user?.type === "Bot")
        return "Bot";
    switch (assoc) {
        case "OWNER": return "Owner";
        case "MEMBER": return "Member";
        case "CONTRIBUTOR": return "Contributor";
        case "COLLABORATOR": return "Collaborator";
        case "NONE": return "";
        default: return "";
    }
}
function labelAssociation(assoc, user) {
    const a = formatAssociation(assoc, user);
    return a ? ` · ${a}` : "";
}
function formatDuration(startedAt, completedAt) {
    if (!startedAt || !completedAt)
        return "";
    const start = new Date(startedAt).getTime();
    const end = new Date(completedAt).getTime();
    const diffMs = end - start;
    if (diffMs < 1000)
        return `${diffMs}ms`;
    const sec = Math.round(diffMs / 1000);
    if (sec < 60)
        return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
}
const LINE_DOUBLE = "════════════════════════════════════════════════════════════════";
const LINE_SINGLE = "────────────────────────────────────────────────────────────────";
// ─── Suggestion parsing ──────────────────────────────────────────────────────
/**
 * Walk the diff hunk and return the lines whose right-side (new-file) line
 * numbers fall in [startLine, endLine]. Returns null if the hunk header is
 * unparseable or the range falls outside the hunk.
 */
function extractRangeFromHunk(diffHunk, startLine, endLine) {
    const lines = diffHunk.split("\n");
    let headerIdx = -1;
    let newStart = null;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) {
            headerIdx = i;
            newStart = parseInt(m[1], 10);
            break;
        }
    }
    if (headerIdx < 0 || newStart === null)
        return null;
    let newLineNum = newStart;
    const collected = [];
    let sawAny = false;
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        // Removed lines exist only in the OLD file and don't advance the new line
        // counter; they also aren't part of what a suggestion replaces.
        if (l.startsWith("-"))
            continue;
        if (newLineNum >= startLine && newLineNum <= endLine) {
            sawAny = true;
            // Strip the leading "+" or " " prefix; if neither (e.g. "\ No newline"),
            // keep the line as-is.
            collected.push(l.startsWith("+") || l.startsWith(" ") ? l.slice(1) : l);
        }
        newLineNum++;
    }
    return sawAny ? collected : null;
}
function stripSuggestionBlocks(body) {
    return body.replace(/```suggestion\s*\n[\s\S]*?```/g, "").trimEnd();
}
function parseSuggestions(body, diffHunk, startLine, endLine) {
    const suggestions = [];
    const regex = /```suggestion\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
        const replacement = match[1].replace(/\n$/, "").split("\n");
        // Anchor the original text using the comment's startLine/endLine mapped
        // through the diff hunk header — taking the tail of the hunk only works
        // when the suggestion lives at the end of its hunk, which isn't always
        // the case.
        let original = null;
        const anchorStart = startLine ?? endLine;
        const anchorEnd = endLine ?? startLine;
        if (anchorStart && anchorEnd) {
            original = extractRangeFromHunk(diffHunk, anchorStart, anchorEnd);
        }
        if (original === null) {
            // Fallback: last `rangeSize` non-removed lines of the hunk (the legacy
            // behavior, used only when we can't parse the hunk header).
            const rangeSize = startLine && endLine ? endLine - startLine + 1 : 1;
            const hunkLines = diffHunk.split("\n");
            const contextLines = [];
            for (const hl of hunkLines) {
                if (hl.startsWith("@@"))
                    continue;
                if (hl.startsWith("-"))
                    continue;
                contextLines.push(hl.startsWith("+") ? hl.slice(1) : hl.startsWith(" ") ? hl.slice(1) : hl);
            }
            original = contextLines.slice(-rangeSize);
        }
        suggestions.push({ original, replacement });
    }
    return suggestions;
}
/** Parse the first @@ hunk header in a diff_hunk. */
function parseHunkHeader(diffHunk) {
    const lines = diffHunk.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
        if (m) {
            return {
                headerIdx: i,
                oldStart: parseInt(m[1], 10),
                newStart: parseInt(m[2], 10),
                heading: m[3].replace(/^\s+/, ""),
                body: lines.slice(i + 1),
            };
        }
    }
    return null;
}
/**
 * Walk a parsed hunk and emit one NumberedRow per body line, tracking both the
 * old- and new-file line counters. Removed lines carry only an old number,
 * added lines only a new number, and context lines carry both — exactly how
 * GitHub anchors inline comments and suggestions.
 */
function numberHunkRows(hunk) {
    const rows = [];
    let oldNum = hunk.oldStart;
    let newNum = hunk.newStart;
    for (const l of hunk.body) {
        if (l.startsWith("@@"))
            break; // a second hunk header — stop here
        if (l.startsWith("-")) {
            rows.push({ oldNum, newNum: null, marker: "-", content: l.slice(1) });
            oldNum++;
        }
        else if (l.startsWith("+")) {
            rows.push({ oldNum: null, newNum, marker: "+", content: l.slice(1) });
            newNum++;
        }
        else {
            const content = l.startsWith(" ") ? l.slice(1) : l;
            rows.push({ oldNum, newNum, marker: " ", content });
            oldNum++;
            newNum++;
        }
    }
    return rows;
}
/** Minimal line-level diff between two blocks of lines (LCS-based). */
function diffLines(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ type: "context", text: a[i] });
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({ type: "del", text: a[i] });
            i++;
        }
        else {
            out.push({ type: "add", text: b[j] });
            j++;
        }
    }
    while (i < n) {
        out.push({ type: "del", text: a[i] });
        i++;
    }
    while (j < m) {
        out.push({ type: "add", text: b[j] });
        j++;
    }
    return out;
}
// (The former formatCodeContext / buildSuggestionChangeset helpers were unused
// duplicates of codeContextDiffLines / suggestionDiffBlocks; their line-number
// and @@-header rendering now lives in those live functions.)
/**
 * Lines ready to drop inside a ```diff fence: the hunk rows GitHub anchors the
 * comment to, each carrying its line-number gutter exactly as the PR page
 * shows it — `155 + content` (new-file number for added/context rows, old-file
 * number for removed rows). Numbers are right-aligned across the block.
 */
function codeContextDiffLines(diffHunk, rangeSize) {
    const hunk = parseHunkHeader(diffHunk);
    if (!hunk) {
        return (diffHunk || "").split("\n").filter((l) => l && !l.startsWith("@@"));
    }
    const rows = numberHunkRows(hunk);
    const shown = rows.slice(-Math.max(4, rangeSize));
    const width = Math.max(...shown.map((r) => {
        const num = r.marker === "-" ? r.oldNum : r.newNum;
        return num != null ? String(num).length : 0;
    }), 1);
    return shown.map((r) => {
        const num = r.marker === "-" ? r.oldNum : r.newNum;
        const gutter = (num != null ? String(num) : "").padStart(width);
        return `${gutter} ${r.marker} ${r.content}`.trimEnd();
    });
}
/**
 * For each ```suggestion fence in a comment body, produce the unified diff
 * GitHub shows when previewing the change, ready to drop inside a ```diff
 * fence: a recomputed `@@ -a,b +c,d @@` header, a few lines of leading
 * context from the hunk, then a minimal -/+ diff between the anchored
 * original lines and the suggested replacement — NOT a raw dump of the API
 * diff hunk.
 */
function suggestionDiffBlocks(body, diffHunk, startLine, endLine) {
    const suggestions = parseSuggestions(body || "", diffHunk || "", startLine, endLine);
    if (suggestions.length === 0)
        return [];
    const hunk = parseHunkHeader(diffHunk || "");
    const anchorStart = startLine ?? endLine;
    const CONTEXT = 3;
    const blocks = [];
    for (const { original, replacement } of suggestions) {
        let before = [];
        if (hunk && anchorStart != null) {
            before = numberHunkRows(hunk)
                .filter((r) => r.newNum != null && r.newNum < anchorStart)
                .map((r) => r.content)
                .slice(-CONTEXT);
        }
        const rows = diffLines(original, replacement);
        const lines = [];
        const oldLen = before.length + original.length;
        const newLen = before.length + replacement.length;
        const displayStart = anchorStart != null
            ? Math.max(1, anchorStart - before.length)
            : (hunk ? hunk.newStart : 1);
        const headingSuffix = hunk && hunk.heading ? ` ${hunk.heading}` : "";
        lines.push(`@@ -${displayStart},${oldLen} +${displayStart},${newLen} @@${headingSuffix}`);
        for (const c of before)
            lines.push(` ${c}`);
        for (const row of rows) {
            const prefix = row.type === "del" ? "-" : row.type === "add" ? "+" : " ";
            lines.push(`${prefix}${row.text}`);
        }
        blocks.push(lines);
    }
    return blocks;
}
/**
 * Best-effort severity extraction from a review comment body (Copilot /
 * CodeRabbit emit it inline). Returns a capitalized level or null.
 */
function extractSeverity(body) {
    if (!body)
        return null;
    const m = body.match(/severity[:\s*]*\**\s*(low|medium|high|critical|info|minor|major)\b/i);
    return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}
/** GitHub labels AI reviewers (Copilot) as "[AI]" and other bots as "[Bot]". */
function actorSuffix(user) {
    if (!user)
        return "";
    if (/copilot/i.test(user.login || ""))
        return " [AI]";
    if (user.type === "Bot" || /\[bot\]$/i.test(user.login || ""))
        return " [Bot]";
    return "";
}
/** Display name as the PR page shows it: the literal "[bot]" suffix in a bot
 *  login (e.g. "gemini-code-assist[bot]") is dropped — the badge comes from
 *  actorSuffix instead, so we never print "name[bot] [Bot]". */
function displayActor(user) {
    const login = String(user?.login || "").replace(/\[bot\]$/i, "");
    return `${login}${actorSuffix(user)}`;
}
// ─── Timeline construction ───────────────────────────────────────────────────
function buildCards(issueComments, reviews, reviewComments, resolvedMap, includeResolved) {
    const cards = [];
    // Issue (conversation) comments.
    for (const c of issueComments) {
        cards.push({ kind: "issue_comment", timestamp: c.created_at, data: c });
    }
    // Review summary "events" — only when the review carries a body or a verdict.
    // A plain COMMENTED review with no body contributes only its inline threads,
    // so we don't emit an empty event card for it.
    for (const r of reviews) {
        const state = String(r.state || "").toUpperCase();
        const hasVerdict = state === "CHANGES_REQUESTED" || state === "APPROVED" || state === "DISMISSED";
        if ((r.body && r.body.trim()) || hasVerdict) {
            cards.push({ kind: "review_event", timestamp: r.submitted_at || r.created_at, data: r });
        }
    }
    // Inline review threads — group each root comment with its replies.
    const threadRoots = new Map();
    const threadReplies = new Map();
    for (const rc of reviewComments) {
        if (rc.in_reply_to_id == null) {
            threadRoots.set(rc.id, rc);
            if (!threadReplies.has(rc.id))
                threadReplies.set(rc.id, []);
        }
        else {
            const rootId = rc.in_reply_to_id;
            if (!threadReplies.has(rootId))
                threadReplies.set(rootId, []);
            threadReplies.get(rootId).push(rc);
        }
    }
    for (const [rootId, root] of threadRoots) {
        const replies = (threadReplies.get(rootId) || [])
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        const isOutdated = root.line == null && root.original_line != null;
        let isResolved = null;
        if (resolvedMap !== null)
            isResolved = resolvedMap[root.id] ?? null;
        if (!includeResolved && isResolved === true)
            continue;
        cards.push({
            kind: "inline_thread",
            timestamp: root.created_at,
            thread: { rootComment: root, replies, isOutdated, isResolved },
        });
    }
    // Scroll order is chronological. On ties, a review event sorts before the
    // inline threads submitted with it (they share a timestamp).
    const rank = (c) => (c.kind === "review_event" ? 0 : 1);
    cards.sort((a, b) => {
        const ta = new Date(a.timestamp).getTime();
        const tb = new Date(b.timestamp).getTime();
        if (ta !== tb)
            return ta - tb;
        return rank(a) - rank(b);
    });
    return cards;
}
// ─── CI categorization (shared) ──────────────────────────────────────────────
function categorizeChecks(checks) {
    const inProgress = checks.filter(c => c.status !== "completed" || c.conclusion === null);
    const passed = checks.filter(c => c.status === "completed" && (c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped"));
    const failed = checks.filter(c => c.status === "completed" &&
        (c.conclusion === "failure" || c.conclusion === "cancelled" ||
            c.conclusion === "timed_out" || c.conclusion === "action_required" || c.conclusion === "stale"));
    return { inProgress, passed, failed };
}
/**
 * Run `transform` on the prose of `s` while protecting code byte-for-byte:
 *
 *   - Fenced blocks (``` … ```) are cut out entirely and never shown to the
 *     transform — review diffs, suggestion bodies, and code examples must
 *     never be altered by prose cleanup.
 *   - Inline code spans (`…`) are replaced with inert placeholder tokens
 *     before the transform and restored after. Tokenizing (rather than
 *     splitting) keeps the surrounding prose CONTIGUOUS, so patterns that
 *     straddle a code span — the very common [`file.ts`](url) link shape —
 *     still match, while the span's contents (`[x](y)`, `<https://…>`,
 *     `<img>`) can never be mistaken for removable debris.
 *
 * A token deleted by the transform (e.g. a code span inside a removed HTML
 * comment) simply restores nothing — deletion of a protected span can only
 * happen when its whole enclosing construct was removed.
 *
 * Known accepted limitations: an unclosed fence leaves its tail treated as
 * prose, and double-backtick (``…``) spans are not recognized — both rare in
 * PR comment bodies, with bounded failure direction.
 */
function transformProse(s, transform) {
    const nonce = randomBytes(6).toString("hex");
    return s
        .split(/(```[\s\S]*?```)/g)
        .map((part, i) => {
        if (i % 2 === 1)
            return part; // fenced block — byte-faithful
        const spans = [];
        // Bare alphanumeric tokens, no delimiter characters: cleanup patterns
        // consume adjacent whitespace and punctuation, and a delimiter that got
        // consumed would break restoration — deleting the code span and leaking
        // token text. Plain hex with colons survives every pass untouched.
        const tokenized = part.replace(/`[^`\n]*`/g, (m) => {
            const token = `${nonce}:${spans.length}:`;
            spans.push(m);
            return token;
        });
        let out = transform(tokenized);
        for (let j = 0; j < spans.length; j++) {
            out = out.split(`${nonce}:${j}:`).join(spans[j]);
        }
        return out;
    })
        .join("");
}
/**
 * Run `transform` over `s` with fenced blocks AND inline code spans replaced
 * by inert nonce tokens (then restored). Unlike `transformProse`, the masked
 * string stays CONTIGUOUS — so multi-line constructs that legitimately span
 * fences (a bot `<details>` footer wrapping a ```log fence, a multi-line
 * HTML comment) still match and are removed as one unit, fences included.
 * A fence or code span that merely SHOWS such syntax is masked and therefore
 * invisible to the transform — protected.
 *
 * Tokens whose construct was removed by the transform restore nothing: the
 * fence belonged to the removed boilerplate and goes with it.
 */
function maskedTransform(s, transform) {
    const nonce = randomBytes(6).toString("hex");
    const stash = [];
    const masked = s
        .replace(/```[\s\S]*?```/g, (m) => {
        const token = `${nonce}:${stash.length}:`;
        stash.push(m);
        return token;
    })
        .replace(/`[^`\n]*`/g, (m) => {
        const token = `${nonce}:${stash.length}:`;
        stash.push(m);
        return token;
    });
    let out = transform(masked);
    for (let j = 0; j < stash.length; j++) {
        out = out.split(`${nonce}:${j}:`).join(stash[j]);
    }
    return out;
}
/**
 * Line-level filter that only sees PROSE lines — every line inside a fenced
 * code block is kept unconditionally. A code/diff line that happens to look
 * like bot noise (a literal "[!NOTE]", a quoted "Thanks for using…" string)
 * must never be dropped from inside a fence.
 */
function filterProseLines(s, keep) {
    return s
        .split(/(```[\s\S]*?```)/g)
        .map((part, i) => i % 2 === 1 ? part : part.split("\n").filter(keep).join("\n"))
        .join("");
}
/** The text of `s` with fenced-block CONTENT removed — for scanning passes
 *  (e.g. severity extraction) that must not read code as prose. */
function proseOnly(s) {
    return s.split(/```[\s\S]*?```/g).join("\n");
}
/** A reference-definition line whose target is URL-shaped (`scheme://…`,
 *  `mailto:`/`tel:`, `<…>`, or starting with `/`, `./`, `#`). Footnotes
 *  (`[^1]: …`) excluded.
 *  Prose that merely looks reference-like (`[ERROR]: timeout`) does NOT match
 *  because `timeout` is not URL-shaped. */
const LINK_DEF_LINE = /^[ \t]*\[(?!\^)([^\]]+)\]:[ \t]*(?:<[^>\n]*>|[a-z][a-z0-9+.-]*:\/\/\S+|(?:mailto|tel):\S+|[./#]\S*)[ \t]*(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))?[ \t]*$/gim;
/**
 * Markdown link/image debris removal — the web→markdown translation artifacts
 * that carry no PR meaning. Fence and inline-code contents are protected
 * internally (via transformProse); call it on the whole body.
 *
 * What goes, and why:
 *   - Images (`![alt](url)`, defined `![alt][ref]`) — removed completely, alt
 *     text included. Badges, mascots, screenshots: none of it helps a reader
 *     address the PR.
 *   - Angle autolinks (`<https://…>`, `<mailto:…>`) — pure translation debris;
 *     the canonical "link populated by the webpage→markdown translation".
 *   - Empty links (`[](url)`) — nothing visible to keep.
 *   - Inline links (`[text](url)`) — unwrapped to `text`. The visible words
 *     are content; the target is web furniture.
 *   - Reference links (`[text][ref]`) — unwrapped to `text`, but ONLY when
 *     `[ref]: url` is defined in the body (GitHub's own rendering rule); their
 *     URL-shaped definition lines are removed.
 *
 * What stays, deliberately:
 *   - Bare URLs the author typed in prose (`see https://example.com`) — a URL
 *     standing as text is the content being discussed.
 *   - Footnotes (`[^1]`, `[^1]: …`) — prose, not link plumbing.
 *   - Bracket pairs without a matching definition (`arr[1][2]`, `[ERROR]: x`)
 *     — GitHub shows them literally, so we keep them literally.
 */
function stripLinkDebris(body) {
    // Pass 1 — collect defined reference labels (CommonMark matches labels
    // case-insensitively). Collected from prose only, so a definition-shaped
    // line inside a code example doesn't activate unwrapping.
    const defined = new Set();
    body.split(/(```[\s\S]*?```)/g).forEach((part, i) => {
        if (i % 2 === 1)
            return; // fence — definitions inside code don't count
        for (const m of part.matchAll(LINK_DEF_LINE))
            defined.add(m[1].trim().toLowerCase());
    });
    // Pass 2 — transform prose segments.
    return transformProse(body, (seg) => {
        let s = seg;
        // Inline images first. (Running link-unwrap first would turn `![alt](url)`
        // into `!alt`.) Leading whitespace is consumed so mid-sentence removal
        // doesn't leave a double space.
        s = s.replace(/[ \t]*!\[[^\]]*\]\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, "");
        // Reference-style images — removed only when their definition exists.
        s = s.replace(/[ \t]*!\[([^\]]*)\]\[([^\]]*)\]/g, (full, alt, ref) => {
            const label = (ref || alt).trim().toLowerCase();
            return defined.has(label) ? "" : full;
        });
        // Angle autolinks — `<https://…>` / `<http://…>` / `<mailto:…>`.
        s = s.replace(/[ \t]*<(?:https?|mailto):[^>\s]*>/gi, "");
        // Empty-text links (the husk left where a badge image sat inside a link).
        s = s.replace(/[ \t]*\[\s*\]\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, "");
        // Inline links — keep the visible text, drop the target. Tolerates up to
        // two levels of balanced parens inside the URL (wikipedia-style).
        s = s.replace(/\[([^\]]*)\]\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, "$1");
        // Reference links — unwrap only when defined (`[text][ref]`, `[text][]`).
        s = s.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (full, text, ref) => {
            const label = (ref || text).trim().toLowerCase();
            return defined.has(label) ? text : full;
        });
        // Remove the URL-shaped definition lines themselves (+ their newline).
        s = s.replace(new RegExp(LINK_DEF_LINE.source + "\\n?", "gim"), "");
        return s;
    });
}
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
export function cleanCommentBody(raw) {
    let s = (raw || "").replace(/\r\n/g, "\n");
    // HTML comments (bot metadata markers) — invisible on the rendered PR page.
    // Masked, not split: a multi-line comment may legitimately span a fence
    // (removed whole), while a code example SHOWING `<!-- … -->` is protected.
    s = maskedTransform(s, (m) => m.replace(/<!--[\s\S]*?-->/g, ""));
    // Remove ALL <details> blocks — these are the collapsible boilerplate bots
    // inject (walkthroughs, tips, share, rate-limit notices, "learnings", file
    // lists, run config). Remove innermost first to handle nesting, and tolerate
    // blockquote-prefixed tags (`> <details>`).
    // Masked, not split: bot <details> footers routinely CONTAIN fenced code
    // (CodeRabbit walkthroughs/logs) and must be removed whole, fence included;
    // a fence that merely SHOWS a <details> tag is masked away and survives.
    s = maskedTransform(s, (m) => {
        let prev;
        do {
            prev = m;
            m = m.replace(/<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/gi, "");
        } while (m !== prev);
        return m;
    });
    // Some bots double-escape newlines (literal "\n") in prose. Turn them into
    // real line breaks — but never inside fenced code blocks or inline code
    // spans, where "\n" is literal code.
    s = transformProse(s, (seg) => seg.replace(/\\n/g, "\n"));
    // Raw-HTML images — removed completely (badges, mascots, screenshots).
    // Fence-guarded: a code example SHOWING an <img> tag keeps it.
    s = transformProse(s, (seg) => seg
        .replace(/[ \t]*<picture>[\s\S]*?<\/picture>/gi, "")
        .replace(/[ \t]*<img\b[^>]*>/gi, ""));
    // Light HTML → Markdown so bot summaries stay readable. The <a> unwrap
    // keeps the visible text and drops the target — link text is content,
    // the URL is web furniture. All fence-guarded.
    s = transformProse(s, (seg) => seg
        .replace(/[ \t]*<a\b[^>]*>\s*<\/a>/gi, "")
        .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
        .replace(/<\/?(?:strong|b)>/gi, "**")
        .replace(/<\/?(?:em|i)>/gi, "*")
        .replace(/<code>([\s\S]*?)<\/code>/gi, (_m, x) => "`" + x.replace(/`/g, "").trim() + "`")
        .replace(/<h[1-6]>([\s\S]*?)<\/h[1-6]>/gi, (_m, x) => `\n**${x.trim()}**\n`)
        .replace(/<li>([\s\S]*?)<\/li>/gi, (_m, x) => `- ${x.trim()}\n`)
        .replace(/<br\s*\/?>/gi, "\n"));
    // Strip any remaining stray tags but keep their inner text. Fence-guarded.
    s = transformProse(s, (seg) => seg.replace(/<\/?(?:details|summary|div|span|sub|sup|p|kbd|samp|blockquote|ul|ol|li|h[1-6]|code|strong|b|em|i|hr|abbr|small|table|thead|tbody|tr|td|th)\b[^>]*>/gi, ""));
    // Line-level removal of pure marketing / bot-status noise (ignoring any
    // leading blockquote `>` prefix).
    //
    // ORDERING CONTRACT: dropLine runs BEFORE stripLinkDebris. The share-spam
    // pattern below identifies its line BY the markdown link target — unwrapping
    // links first would blind it and leak "Share this:" prose into the output.
    const dropLine = (line) => {
        const t = line.replace(/^>+\s?/, "").trim();
        if (/\[[^\]]*\]\([^)]*(?:twitter\.com\/intent|x\.com\/intent|mastodon\.[^/]+\/share|reddit\.com\/submit|linkedin\.com\/sharing)/i.test(t))
            return true;
        if (/^\[!(?:note|tip|important|warning|caution)\]$/i.test(t))
            return true;
        if (/^copilot uses ai\.?\s*check for mistakes\.?$/i.test(t))
            return true;
        if (/^view reviewed changes\s*>?$/i.test(t))
            return true;
        if (/thanks for using \[?coderabbit/i.test(t))
            return true;
        if (/comment\s+`?@coderabbitai/i.test(t))
            return true;
        if (/more reviews will be available in/i.test(t))
            return true;
        if (/run out of usage credits/i.test(t))
            return true;
        if (/review limit reached/i.test(t))
            return true;
        if (/couldn'?t start this review/i.test(t))
            return true;
        if (/reached your pr review rate limit/i.test(t))
            return true;
        if (/space out your commits/i.test(t))
            return true;
        if (/it'?s free for oss/i.test(t))
            return true;
        if (/consumer version of .*gemini code assist/i.test(t))
            return true;
        if (/code review activity will officially cease/i.test(t))
            return true;
        if (/for more details on the timeline and next steps/i.test(t))
            return true;
        return false;
    };
    s = filterProseLines(s, (line) => !dropLine(line));
    // Drop an orphaned "Share" heading. Fence-guarded.
    s = transformProse(s, (seg) => seg.replace(/^#{1,6}\s*share\b.*$/gim, ""));
    // Markdown link/image debris — AFTER dropLine (which matches share-spam BY
    // its link target). Fence/inline-code protection is internal to the
    // function. See stripLinkDebris for the full keep/drop contract.
    s = stripLinkDebris(s);
    // Tidy whitespace and any blockquote lines left empty — outside fences
    // only, so code/diff bytes (trailing spaces, blank runs) stay exact.
    s = transformProse(s, (seg) => seg.replace(/^>\s*$/gm, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n")).trim();
    // Strip leading/trailing horizontal rules (e.g. coderabbit wraps its body in
    // "---"). A bare rule at the edges only collides with the section separators
    // renderPR emits, producing an ugly double "---".
    s = s.replace(/^(?:[-*_]{3,}\s*\n)+/g, "").replace(/(?:\n\s*[-*_]{3,})+\s*$/g, "").trim();
    // If nothing but punctuation / rules / emoji remains, treat as empty so the
    // card is skipped rather than printed as a stray "---" or lone symbol.
    if (!/[\p{L}\p{N}]/u.test(s))
        return "";
    return s;
}
// ═══════════════════════════════════════════════════════════════════════════════
// renderPR — Conversation/UI mirror (from Prompt 1)
// ═══════════════════════════════════════════════════════════════════════════════
export async function renderPR(data, options) {
    const { pr, commits, reviews, issueComments, resolvedThreadMap, unifiedChecks } = data;
    const { outputPath, includeResolvedThreads = true } = options;
    const cards = buildCards(issueComments, reviews, data.reviewComments, resolvedThreadMap, includeResolvedThreads);
    const out = [];
    // Writes go to a switchable target so the Comments flow can be buffered and
    // its heading emitted only when at least one card actually rendered.
    let target = out;
    const w = (line = "") => target.push(line);
    const blank = () => target.push("");
    const state = pr.merged ? "Merged" : pr.state === "open" ? "Open" : "Closed";
    const action = pr.merged ? "merged" : pr.state === "open" ? "wants to merge" : "closed";
    // Reviewers (sidebar) — Copilot shown plain, other bots flagged "[Bot]".
    const submittedReviewers = [...new Set(reviews.map((r) => r.user.login))];
    const requestedNames = (pr.requested_reviewers || []).map((r) => r.login);
    const allReviewerNames = [...new Set([...requestedNames, ...submittedReviewers])];
    const reviewers = allReviewerNames.length > 0
        ? allReviewerNames.map((name) => {
            const reviewer = [...(pr.requested_reviewers || []), ...reviews.map((r) => r.user)]
                .find((u) => u.login === name);
            if (/copilot/i.test(name))
                return name;
            const isBot = reviewer?.type === "Bot" || /\[bot\]$/i.test(name);
            const display = name.replace(/\[bot\]$/i, "");
            return isBot ? `${display} [Bot]` : display;
        })
        : ["None"];
    const assignees = pr.assignees?.length > 0 ? pr.assignees.map((a) => a.login) : ["No one"];
    const labels = pr.labels?.length > 0 ? pr.labels.map((l) => l.name) : ["None"];
    const milestone = pr.milestone ? pr.milestone.title : "None";
    const lineAnchor = (root) => {
        const line = root.line ?? root.original_line;
        const startLine = root.start_line ?? root.original_start_line;
        if (startLine && line && startLine !== line)
            return `lines +${startLine} to +${line}`;
        if (line)
            return `line +${line}`;
        return "line (position unknown)";
    };
    const conclusionLabel = (c) => {
        switch (c) {
            case "success": return "Successful";
            case "neutral": return "Neutral";
            case "skipped": return "Skipped";
            default: return c ? c[0].toUpperCase() + c.slice(1) : "Successful";
        }
    };
    // GitHub phrases review verdicts as verbs ("requested changes").
    const reviewVerb = (rawState) => {
        switch (String(rawState || "").toUpperCase()) {
            case "CHANGES_REQUESTED": return "requested changes";
            case "APPROVED": return "approved these changes";
            case "DISMISSED": return "dismissed a review";
            case "COMMENTED": return "reviewed";
            default: return String(rawState || "reviewed").toLowerCase().replace(/_/g, " ");
        }
    };
    // A standalone "Severity: Medium" line in a bot comment body — surfaced in
    // the thread header instead, so the duplicate body line is dropped. Only a
    // LINE that is nothing but the severity tag matches; prose that mentions
    // severity mid-sentence is untouched.
    const stripSeverityLine = (body) => filterProseLines(body, (line) => !/^\s*\**\s*severity\s*:?\s*\**\s*(?:low|medium|high|critical|info|minor|major)\s*\**\s*$/i.test(line));
    // Render one inline review thread as clean Markdown: reviewer (+ severity),
    // file + anchor, a line-numbered ```diff code-context block, the comment
    // prose, then any suggested change as its own numbered ```diff changeset,
    // followed by real replies (no UI reply boxes or action buttons).
    const writeThreadMd = (thread, resolved) => {
        const root = thread.rootComment;
        const filePath = root.path;
        const sl = root.start_line ?? root.original_start_line ?? null;
        const el = root.line ?? root.original_line ?? null;
        const rangeSize = sl && el ? el - sl + 1 : 1;
        const outdatedTag = thread.isOutdated && !resolved ? " _(outdated)_" : "";
        const severity = extractSeverity(proseOnly(root.body || ""));
        const severityTag = severity ? ` · Severity: ${severity}` : "";
        w(`**${displayActor(root.user)}** reviewed · ${formatDate(root.created_at)}${severityTag}`);
        blank();
        w(`\`${filePath}\` — ${lineAnchor(root)}${outdatedTag}`);
        blank();
        const ctx = codeContextDiffLines(root.diff_hunk || "", rangeSize);
        if (ctx.length > 0) {
            w("```diff");
            for (const l of ctx)
                w(l);
            w("```");
            blank();
        }
        const body = cleanCommentBody(stripSeverityLine(stripSuggestionBlocks(root.body || "")));
        if (body) {
            w(body);
            blank();
        }
        let changesetNum = 1;
        for (const block of suggestionDiffBlocks(root.body || "", root.diff_hunk || "", sl, el)) {
            w(`**Suggested changeset ${changesetNum++}:** \`${filePath}\``);
            w("```diff");
            for (const l of block)
                w(l);
            w("```");
            blank();
        }
        for (const reply of thread.replies) {
            const rSeverity = extractSeverity(proseOnly(reply.body || ""));
            const rSeverityTag = rSeverity ? ` · Severity: ${rSeverity}` : "";
            w(`**${displayActor(reply.user)}** replied · ${formatDate(reply.created_at)}${rSeverityTag}`);
            blank();
            const rbody = cleanCommentBody(stripSeverityLine(stripSuggestionBlocks(reply.body || "")));
            if (rbody) {
                w(rbody);
                blank();
            }
            const rsl = reply.start_line ?? reply.original_start_line ?? sl;
            const rel = reply.line ?? reply.original_line ?? el;
            let rChangesetNum = 1;
            for (const block of suggestionDiffBlocks(reply.body || "", reply.diff_hunk || root.diff_hunk || "", rsl, rel)) {
                w(`**Suggested changeset ${rChangesetNum++}:** \`${reply.path || filePath}\``);
                w("```diff");
                for (const l of block)
                    w(l);
                w("```");
                blank();
            }
        }
    };
    // ── Title + status ───────────────────────────────────────────────────────────
    w(`# PR #${pr.number} — ${pr.title}`);
    blank();
    w(`**${state}** · ${pr.user.login} ${action} ${commits.length} commit${commits.length !== 1 ? "s" : ""} into \`${pr.base.ref}\` from \`${pr.head.ref}\``);
    blank();
    const conversationCount = issueComments.length +
        data.reviewComments.length +
        reviews.filter((r) => r.body && r.body.trim()).length;
    w(`Conversation ${conversationCount} · Commits ${commits.length} · Checks ${unifiedChecks.length} · Files changed ${pr.changed_files} · \`+${pr.additions}\` \`−${pr.deletions}\``);
    // ── PR description (directly under the title, not labeled as a comment) ───────
    blank();
    const descClean = pr.body && pr.body.trim() ? cleanCommentBody(pr.body) : "";
    w(descClean || "_No description provided._");
    // ── PR information ───────────────────────────────────────────────────────────
    blank();
    w("---");
    blank();
    w(`- **Reviewers:** ${reviewers.join(", ")}`);
    w(`- **Assignees:** ${assignees.join(", ")}`);
    w(`- **Labels:** ${labels.join(", ")}`);
    w("- **Projects:** None");
    w(`- **Milestone:** ${milestone}`);
    w("- **Development:** No linked issues");
    // ── Comments (scroll order; resolved threads deferred to their own section) ───
    // Buffered: the heading prints only when a card survives cleaning — a PR
    // whose every comment is promo-only (or purely resolved) gets no empty
    // "## Comments" stub.
    const commentBuf = [];
    const resolvedThreads = [];
    let n = 1;
    target = commentBuf;
    for (const card of cards) {
        if (card.kind === "inline_thread" && card.thread && card.thread.isResolved === true) {
            resolvedThreads.push(card.thread);
            continue;
        }
        // Build the card content first so cards that are pure bot boilerplate
        // (empty after cleaning, with no review verdict) can be skipped without
        // consuming a Comment number.
        let header = "";
        let body = "";
        if (card.kind === "issue_comment") {
            const c = card.data;
            body = cleanCommentBody(c.body || "");
            if (!body)
                continue;
            header = `**${displayActor(c.user)}** commented · ${formatDate(c.created_at)}`;
        }
        else if (card.kind === "review_event") {
            const r = card.data;
            body = cleanCommentBody(r.body || "");
            const verdict = String(r.state || "").toUpperCase();
            const hasVerdict = verdict === "CHANGES_REQUESTED" || verdict === "APPROVED" || verdict === "DISMISSED";
            if (!body && !hasVerdict)
                continue;
            header = `**${displayActor(r.user)}** ${reviewVerb(r.state)} · ${formatDate(r.submitted_at || r.created_at)}`;
        }
        blank();
        w(`### Comment #${n++}`);
        blank();
        if (card.kind === "inline_thread" && card.thread) {
            writeThreadMd(card.thread, false);
        }
        else {
            w(header);
            if (body) {
                blank();
                w(body);
            }
        }
    }
    target = out;
    if (commentBuf.length > 0) {
        blank();
        w("---");
        blank();
        w("## Comments");
        out.push(...commentBuf);
    }
    // ── Resolved threads (own section; omitted entirely when there are none) ──────
    if (resolvedThreads.length > 0) {
        blank();
        w("---");
        blank();
        w("## Resolved");
        let rn = 1;
        for (const thread of resolvedThreads) {
            blank();
            w(`### Resolved Comment #${rn++}`);
            blank();
            writeThreadMd(thread, true);
        }
    }
    // ── Checks (compact: one line per check, no links or marketing blurbs) ────────
    const { inProgress, passed, failed } = categorizeChecks(unifiedChecks);
    blank();
    w("---");
    blank();
    w("## Checks");
    blank();
    w(`${passed.length} successful · ${inProgress.length} in progress · ${failed.length} failed`);
    if (failed.length + inProgress.length + passed.length > 0)
        blank();
    for (const c of failed) {
        const d = formatDuration(c.startedAt, c.completedAt);
        w(`- ✗ ${c.name} — Failed${d ? ` in ${d}` : ""}`);
    }
    for (const c of inProgress) {
        w(`- ◷ ${c.name} — In progress`);
    }
    for (const c of passed) {
        const d = formatDuration(c.startedAt, c.completedAt);
        w(`- ✓ ${c.name} — ${conclusionLabel(c.conclusion)}${d ? ` in ${d}` : ""}`);
    }
    // ── Merge status (one line; no merge button) ─────────────────────────────────
    const changesRequested = reviews.filter((r) => r.state === "CHANGES_REQUESTED");
    const pendingReviews = reviews.filter((r) => r.state === "PENDING");
    blank();
    w("---");
    blank();
    if (pr.merged) {
        w(`**Merged** by ${pr.merged_by?.login || pr.user.login} on ${formatDate(pr.merged_at || pr.updated_at)}.`);
    }
    else if (pr.mergeable === true && pr.mergeable_state === "clean") {
        w("**This branch has no conflicts and can be merged.**");
    }
    else {
        const reasons = [];
        if (pr.mergeable_state === "dirty")
            reasons.push("merge conflicts");
        if (changesRequested.length > 0)
            reasons.push(`${changesRequested.length} change${changesRequested.length !== 1 ? "s" : ""} requested`);
        if (pendingReviews.length > 0)
            reasons.push(`${pendingReviews.length} pending review${pendingReviews.length !== 1 ? "s" : ""}`);
        if (inProgress.length > 0)
            reasons.push(`${inProgress.length} check${inProgress.length !== 1 ? "s" : ""} in progress`);
        if (failed.length > 0)
            reasons.push(`${failed.length} check${failed.length !== 1 ? "s" : ""} failed`);
        w(reasons.length > 0 ? `**Merging is blocked** — ${reasons.join(", ")}.` : "**Merging is blocked.**");
    }
    const joined = out.join("\n");
    const collapsed = joined
        .split(/(```[\s\S]*?```)/g)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(/\n{3,}/g, "\n\n")))
        .join("");
    const output = collapsed.replace(/\s+$/, "") + "\n";
    await writeFile(outputPath, output, "utf-8");
    console.error(`Written review to ${outputPath} (${output.length} bytes)`);
}
// ═══════════════════════════════════════════════════════════════════════════════
// renderReport — CI/Commits/Files technical report (Prompt 2)
// ═══════════════════════════════════════════════════════════════════════════════
/** Extract relevant failure lines from a log blob */
function extractFailureLines(text, maxLines = 20) {
    const lines = text.split("\n");
    const FAIL_KEYWORDS = /\b(FAIL|Error|error:|fatal:|assert|Expected|Received)\b|[✕✗]/i;
    const matchIndices = [];
    for (let i = 0; i < lines.length; i++) {
        if (FAIL_KEYWORDS.test(lines[i])) {
            matchIndices.push(i);
        }
    }
    if (matchIndices.length === 0)
        return [];
    // Collect matched lines + 3 lines of context each
    const included = new Set();
    for (const idx of matchIndices.slice(0, maxLines)) {
        for (let i = Math.max(0, idx - 3); i <= Math.min(lines.length - 1, idx + 3); i++) {
            included.add(i);
        }
    }
    const sorted = Array.from(included).sort((a, b) => a - b);
    const result = [];
    let prevIdx = -2;
    for (const idx of sorted) {
        if (idx > prevIdx + 1 && result.length > 0) {
            result.push("  ...");
        }
        result.push(lines[idx]);
        prevIdx = idx;
    }
    return result.slice(0, maxLines * 3); // cap total output
}
export async function renderReport(data, options) {
    const { pr, commits, files, unifiedChecks, rateLimitState: rl } = data;
    const { owner, repo, token, outputPath } = options;
    const base = `/repos/${owner}/${repo}`;
    const headSha = pr.head.sha;
    const out = [];
    const w = (line = "") => out.push(line);
    // ─── 1. CI Status ──────────────────────────────────────────────────────
    w(`CI STATUS — PR #${pr.number}`);
    w();
    const { inProgress, passed, failed } = categorizeChecks(unifiedChecks);
    // Failed checks with detailed failure info
    if (failed.length > 0) {
        w(`FAILED (${failed.length}):`);
        w();
        for (const fc of failed) {
            const dur = formatDuration(fc.startedAt, fc.completedAt);
            w(`  ✗ ${fc.name}`);
            if (dur)
                w(`    Duration: ${dur}`);
            w(`    Failure details:`);
            let hasDetails = false;
            // Priority 1: Annotations
            if (fc.checkRunId) {
                try {
                    const anns = await fetchAllPages(`${base}/check-runs/${fc.checkRunId}/annotations`, token, rl);
                    if (anns.length > 0) {
                        hasDetails = true;
                        for (const ann of anns) {
                            const loc = ann.path && ann.start_line
                                ? `${ann.path}:${ann.start_line}${ann.end_line && ann.end_line !== ann.start_line ? `-${ann.end_line}` : ""}`
                                : null;
                            if (loc) {
                                w(`      [${ann.annotation_level || "failure"}] ${loc}`);
                                w(`      ${ann.message || ann.title || "(no message)"}`);
                                // Try to fetch file content around the annotation
                                if (ann.path && ann.start_line) {
                                    try {
                                        const fileData = await apiFetch(`${base}/contents/${ann.path}?ref=${headSha}`, token, rl);
                                        if (fileData.content && fileData.encoding === "base64") {
                                            const content = Buffer.from(fileData.content, "base64").toString("utf-8");
                                            const fileLines = content.split("\n");
                                            const start = Math.max(0, ann.start_line - 11);
                                            const end = Math.min(fileLines.length, (ann.end_line || ann.start_line) + 10);
                                            w(`      ┌─ ${ann.path}:${start + 1}-${end}`);
                                            for (let i = start; i < end; i++) {
                                                const lineNum = String(i + 1).padStart(4);
                                                const marker = (i + 1 >= ann.start_line && i + 1 <= (ann.end_line || ann.start_line))
                                                    ? "»" : " ";
                                                w(`      ${marker} ${lineNum} │ ${fileLines[i]}`);
                                            }
                                            w(`      └─`);
                                        }
                                    }
                                    catch {
                                        // File content fetch failed — not critical
                                    }
                                }
                            }
                            else {
                                w(`      ${ann.message || ann.title || "(no message)"}`);
                            }
                            w();
                        }
                    }
                }
                catch (e) {
                    console.error(`Warning: Could not fetch annotations for ${fc.name}: ${e.message}`);
                }
            }
            // Priority 2: output.text / output.summary from the check run details
            if (!hasDetails && fc.checkRunId) {
                try {
                    const checkDetail = await apiFetch(`${base}/check-runs/${fc.checkRunId}`, token, rl);
                    const outputText = checkDetail.output?.text || "";
                    const outputSummary = checkDetail.output?.summary || "";
                    const blob = outputText || outputSummary;
                    if (blob) {
                        const extracted = extractFailureLines(blob);
                        if (extracted.length > 0) {
                            hasDetails = true;
                            for (const line of extracted) {
                                w(`      ${line}`);
                            }
                        }
                    }
                }
                catch (e) {
                    console.error(`Warning: Could not fetch check run detail for ${fc.name}: ${e.message}`);
                }
            }
            if (!hasDetails) {
                if (fc.description) {
                    w(`      ${fc.description}`);
                }
                else {
                    w(`      No failure details available from the API. Check the Actions tab directly.`);
                }
            }
            w();
        }
    }
    // Passed checks
    if (passed.length > 0) {
        w(`PASSED (${passed.length}):`);
        for (const c of passed) {
            const dur = formatDuration(c.startedAt, c.completedAt);
            const durStr = dur ? ` — ${dur}` : "";
            w(`  ✓ ${c.name}${durStr}`);
        }
        w();
    }
    // In-progress checks
    if (inProgress.length > 0) {
        w(`IN PROGRESS (${inProgress.length}):`);
        for (const c of inProgress) {
            const desc = c.description ? ` — ${c.description}` : "";
            w(`  ~ ${c.name}${desc}`);
        }
        w();
    }
    if (unifiedChecks.length === 0) {
        w("No checks configured for this PR.");
        w();
    }
    // ─── 2. Changed Files ─────────────────────────────────────────────────
    w(LINE_SINGLE);
    w(`CHANGED FILES (${files.length} files)  +${pr.additions} / -${pr.deletions}`);
    w(LINE_SINGLE);
    w();
    // Sort: removed first, then modified, then added, then renamed/copied
    const statusOrder = {
        removed: 0, modified: 1, renamed: 2, copied: 3, added: 4,
    };
    const sortedFiles = [...files].sort((a, b) => {
        return (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
    });
    for (const f of sortedFiles) {
        const adds = f.additions ?? 0;
        const dels = f.deletions ?? 0;
        const stats = `+${adds} / -${dels}`;
        if (f.status === "renamed") {
            w(`renamed  ${f.previous_filename} → ${f.filename}  ${stats}`);
        }
        else {
            w(`${f.status.padEnd(9)} ${f.filename}  ${stats}`);
        }
    }
    w();
    // ─── 3. Commit History ────────────────────────────────────────────────
    w(LINE_SINGLE);
    w(`COMMITS (${commits.length})`);
    w(LINE_SINGLE);
    w();
    // Chronological order (oldest first) — GitHub API returns oldest first for PR commits
    for (let i = 0; i < commits.length; i++) {
        const c = commits[i];
        const sha = c.sha.slice(0, 7);
        const authorName = c.commit?.author?.name || c.author?.login || "Unknown";
        const timestamp = formatDate(c.commit?.author?.date || c.commit?.committer?.date || "");
        const firstLine = (c.commit?.message || "").split("\n")[0];
        w(`${String(i + 1).padStart(2)}.  ${sha}  ${authorName}  ${timestamp}`);
        w(`      ${firstLine}`);
        w();
    }
    const output = out.join("\n");
    await writeFile(outputPath, output, "utf-8");
    console.error(`Written report to ${outputPath} (${output.length} bytes)`);
}
// ═══════════════════════════════════════════════════════════════════════════════
// Conflict detection, reporting, and resolution (Prompt 3)
// ═══════════════════════════════════════════════════════════════════════════════
// ─── Language detection ──────────────────────────────────────────────────────
const EXT_TO_LANG = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
    ".rb": "ruby", ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
    ".cs": "csharp", ".php": "php", ".swift": "swift", ".kt": "kotlin",
    ".sh": "bash", ".yml": "yaml", ".yaml": "yaml", ".json": "json",
    ".md": "markdown", ".sql": "sql", ".css": "css", ".html": "html",
    ".xml": "xml", ".toml": "toml", ".lock": "", ".txt": "",
};
function langForFile(filePath) {
    return EXT_TO_LANG[extname(filePath)] ?? "";
}
/**
 * Classify what kind of change a conflict region represents.
 * With diff3 ancestor info, we can tell which side(s) modified the region.
 * Without it, we fall back to comparing base vs incoming emptiness.
 */
function classifyConflict(region) {
    const baseEmpty = region.baseContent.trim() === "";
    const incomingEmpty = region.incomingContent.trim() === "";
    if (region.ancestorContent !== undefined) {
        const ancestorEmpty = region.ancestorContent.trim() === "";
        const baseChanged = region.baseContent !== region.ancestorContent;
        const incomingChanged = region.incomingContent !== region.ancestorContent;
        if (baseChanged && incomingChanged) {
            if (ancestorEmpty)
                return "Both sides added content to this region";
            if (baseEmpty)
                return "Baseline deleted this region; incoming modified it";
            if (incomingEmpty)
                return "Incoming deleted this region; baseline modified it";
            return "Both sides modified this region";
        }
        if (baseChanged)
            return "Only baseline modified this region (incoming matches ancestor)";
        if (incomingChanged)
            return "Only incoming modified this region (baseline matches ancestor)";
        return "Neither side modified this region (possible whitespace or merge artifact)";
    }
    // No ancestor — best-effort classification
    if (baseEmpty && !incomingEmpty)
        return "Baseline has no content; incoming added lines";
    if (!baseEmpty && incomingEmpty)
        return "Incoming has no content; baseline added lines";
    if (baseEmpty && incomingEmpty)
        return "Both sides are empty (possible deletion conflict)";
    return "Both sides modified this region";
}
// ─── Conflict marker parsing ─────────────────────────────────────────────────
function parseConflictMarkers(content) {
    const lines = content.split("\n");
    const raw = [];
    let i = 0;
    while (i < lines.length) {
        if (!lines[i].startsWith("<<<<<<<")) {
            i++;
            continue;
        }
        const startLine = i + 1; // 1-based
        const baseLines = [];
        const incomingLines = [];
        const ancestorLines = [];
        let hasAncestor = false;
        i++; // skip <<<<<<< line
        // Collect base content (ours)
        while (i < lines.length && !lines[i].startsWith("=======") && !lines[i].startsWith("|||||||")) {
            baseLines.push(lines[i]);
            i++;
        }
        // Check for diff3 ancestor section
        if (i < lines.length && lines[i].startsWith("|||||||")) {
            hasAncestor = true;
            i++; // skip ||||||| line
            while (i < lines.length && !lines[i].startsWith("=======")) {
                ancestorLines.push(lines[i]);
                i++;
            }
        }
        if (i < lines.length && lines[i].startsWith("=======")) {
            i++; // skip ======= line
        }
        // Collect incoming content (theirs)
        while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
            incomingLines.push(lines[i]);
            i++;
        }
        const endLine = i + 1; // 1-based, inclusive of >>>>>>> line
        if (i < lines.length)
            i++; // skip >>>>>>> line
        raw.push({
            startLine,
            endLine,
            baseContent: baseLines.join("\n"),
            incomingContent: incomingLines.join("\n"),
            ancestorContent: hasAncestor ? ancestorLines.join("\n") : undefined,
        });
    }
    // Pass 2: add context from the actual conflicted file.
    // Each region gets up to 10 clean lines above and below. When nearby regions
    // are closer than that, trim only the overlapping clean-context lines so the
    // report stays true to the file without printing the same line twice.
    const CONTEXT_LINES = 10;
    const regions = [];
    let lastContextAfterEnd = 0; // 0-based exclusive end of the previous region's after-context
    for (let r = 0; r < raw.length; r++) {
        const region = raw[r];
        const beforeEnd = region.startLine - 1; // 0-based index of <<<<<<< marker
        const desiredBeforeStart = Math.max(0, beforeEnd - CONTEXT_LINES);
        const ctxBeforeStart = Math.max(desiredBeforeStart, lastContextAfterEnd);
        const contextBefore = lines.slice(ctxBeforeStart, beforeEnd);
        const afterStart = region.endLine; // 0-based index just after >>>>>>> marker
        const nextStart = r < raw.length - 1 ? raw[r + 1].startLine - 1 : lines.length;
        const ctxAfterEnd = Math.min(lines.length, afterStart + CONTEXT_LINES, nextStart);
        const contextAfter = lines.slice(afterStart, ctxAfterEnd);
        lastContextAfterEnd = ctxAfterEnd;
        regions.push({
            ...region,
            contextBefore,
            contextAfter,
        });
    }
    return regions;
}
// ─── Git worktree helpers ────────────────────────────────────────────────────
/** Timeout for network git operations (fetch). */
const GIT_FETCH_TIMEOUT = 60_000;
/** Timeout for local git operations (merge, checkout, add, commit, etc.). */
const GIT_LOCAL_TIMEOUT = 30_000;
function gitExec(args, cwd, timeout = GIT_LOCAL_TIMEOUT) {
    try {
        return execFileSync("git", args, {
            cwd, encoding: "utf-8", timeout,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    }
    catch (e) {
        if (e.killed || e.signal === "SIGTERM") {
            const secs = Math.round(timeout / 1000);
            throw new Error(`git ${args[0]} timed out after ${secs}s`);
        }
        throw e;
    }
}
function gitExecSafe(args, cwd, timeout = GIT_LOCAL_TIMEOUT) {
    try {
        const stdout = execFileSync("git", args, {
            cwd, encoding: "utf-8", timeout,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return { ok: true, stdout, stderr: "" };
    }
    catch (e) {
        // Distinguish timeout from other failures
        if (e.killed || e.signal === "SIGTERM") {
            const secs = Math.round(timeout / 1000);
            return { ok: false, stdout: "", stderr: `git ${args[0]} timed out after ${secs}s` };
        }
        return { ok: false, stdout: e.stdout?.toString().trim() ?? "", stderr: e.stderr?.toString().trim() ?? "" };
    }
}
function cleanupWorktree(gitRoot, worktreeDir) {
    try {
        execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
            cwd: gitRoot, timeout: GIT_LOCAL_TIMEOUT,
            stdio: ["pipe", "pipe", "pipe"],
        });
    }
    catch { /* didn't exist or already removed */ }
}
// ─── Git path discovery (worktree-safe) ──────────────────────────────────────
/**
 * Resolve the common Git directory for the repository containing `gitRoot`.
 * Crucially this returns the SHARED admin dir even when `gitRoot` is a linked
 * worktree where `<root>/.git` is a file (a gitfile pointer), not a directory.
 *
 * Use this anywhere code might write under the admin store (reports, scratch
 * worktrees, etc.) — never assume `<root>/.git` is a usable directory.
 */
export function gitCommonDir(gitRoot) {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
/**
 * Fetch the PR's base and head into a private ref namespace so we never have
 * to trust `origin/<branch>` — which for fork PRs may not exist at all, and
 * for same-named branches across repos can validate the wrong commit.
 *
 * Strategy:
 *  - Base: always from `refs/heads/<baseBranch>` on origin (the base repo).
 *  - Head: prefer `refs/pull/<n>/head` (GitHub exposes this for every PR,
 *    including forks). Fall back to fetching the branch directly when that
 *    ref doesn't exist (e.g. local test repos that aren't actual PRs).
 *
 * When pinned SHAs are supplied, verify the fetched refs resolve to exactly
 * those commits — surfacing branch movement as a hard error rather than
 * silently merging the wrong thing.
 */
function fetchPrRefs(gitRoot, base, head, spec) {
    const baseRef = `refs/pr-print/${spec.pullNumber}/base`;
    const headRef = `refs/pr-print/${spec.pullNumber}/head`;
    // Base — from the base repository's branch.
    const baseFetch = gitExecSafe(["fetch", "--no-tags", "--force", "origin",
        `+refs/heads/${base}:${baseRef}`], gitRoot, GIT_FETCH_TIMEOUT);
    if (!baseFetch.ok) {
        throw new Error(`Failed to fetch base ref refs/heads/${base} from origin: ${baseFetch.stderr}`);
    }
    // Head — try the PR ref first (works for forks); fall back to the branch.
    let headFetch = gitExecSafe(["fetch", "--no-tags", "--force", "origin",
        `+refs/pull/${spec.pullNumber}/head:${headRef}`], gitRoot, GIT_FETCH_TIMEOUT);
    if (!headFetch.ok) {
        headFetch = gitExecSafe(["fetch", "--no-tags", "--force", "origin",
            `+refs/heads/${head}:${headRef}`], gitRoot, GIT_FETCH_TIMEOUT);
    }
    if (!headFetch.ok) {
        throw new Error(`Failed to fetch PR head — tried refs/pull/${spec.pullNumber}/head and ` +
            `refs/heads/${head} from origin: ${headFetch.stderr}`);
    }
    const baseResolved = gitExec(["rev-parse", baseRef], gitRoot);
    const headResolved = gitExec(["rev-parse", headRef], gitRoot);
    if (spec.baseSha && baseResolved !== spec.baseSha) {
        throw new Error(`Base SHA mismatch: PR metadata says ${spec.baseSha} but ` +
            `refs/heads/${base} now resolves to ${baseResolved}. ` +
            `Refresh PR metadata and retry.`);
    }
    if (spec.headSha && headResolved !== spec.headSha) {
        throw new Error(`Head SHA mismatch: PR metadata says ${spec.headSha} but ` +
            `the fetched PR head now resolves to ${headResolved}. ` +
            `The PR was updated since metadata was fetched — refresh and retry.`);
    }
    return { baseRef, headRef, baseSha: baseResolved, headSha: headResolved };
}
/**
 * Allocate a unique scratch worktree directory under the common Git dir.
 * Worktree paths must be unique per process to avoid collisions when multiple
 * runs (or stale dirs from killed processes) coexist.
 */
function allocWorktreeDir(gitRoot, label) {
    const common = gitCommonDir(gitRoot);
    const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    return join(common, "pr-reviews", `.${label}-${unique}`);
}
/** Read the unmerged stages for a path. Empty array = no conflict on that path. */
function getUnmergedStages(workTree, path) {
    const r = gitExecSafe(["ls-files", "-u", "--", path], workTree);
    if (!r.ok || !r.stdout)
        return [];
    // Format: "<mode> <oid> <stage>\t<path>"
    const entries = [];
    for (const line of r.stdout.split("\n")) {
        const m = line.match(/^(\d+)\s+([0-9a-f]+)\s+(\d+)\t/);
        if (m) {
            entries.push({ mode: m[1], oid: m[2], stage: parseInt(m[3], 10) });
        }
    }
    return entries;
}
/** Read the stage-0 (resolved) entry for a path, if any. */
function getStagedFingerprint(workTree, path) {
    const r = gitExecSafe(["ls-files", "--stage", "--", path], workTree);
    if (!r.ok || !r.stdout)
        return { kind: "deleted" };
    // First line only — stage-0 entries are unique
    const m = r.stdout.split("\n")[0].match(/^(\d+)\s+([0-9a-f]+)\s+0\t/);
    if (!m)
        return { kind: "deleted" };
    return { kind: "blob", mode: m[1], oid: m[2] };
}
// ─── extractConflicts — trial merge in temp worktree ─────────────────────────
/**
 * Detect conflict regions for the PR by performing a trial merge in an
 * isolated worktree. The worktree is checked out at the base SHA and the
 * head SHA is merged into it, so the resulting markers are in the natural
 * direction for review reporting (ours = base, theirs = head).
 *
 * Note: this differs from the RESOLUTION path, which checks out the head SHA
 * and merges base into it so commits live on the PR's head branch.
 */
export function extractConflicts(gitRoot, base, head, prSpec = { pullNumber: 0 }) {
    const worktreeDir = allocWorktreeDir(gitRoot, "extract");
    // Prune stale worktree lockfiles from killed processes
    gitExecSafe(["worktree", "prune"], gitRoot);
    try {
        const refs = fetchPrRefs(gitRoot, base, head, prSpec);
        // Worktree at base SHA so markers read base=ours, head=theirs.
        gitExec(["worktree", "add", "--detach", worktreeDir, refs.baseSha], gitRoot);
        // Attempt merge of the head SHA.
        const mergeResult = gitExecSafe(["merge", "--no-commit", "--no-ff", refs.headSha], worktreeDir);
        if (mergeResult.ok) {
            return []; // No conflicts
        }
        // Get conflicting file paths
        const conflictOutput = gitExecSafe(["diff", "--name-only", "--diff-filter=U"], worktreeDir);
        if (!conflictOutput.ok || !conflictOutput.stdout) {
            // Merge failed for non-conflict reasons
            console.error(`Warning: Merge failed but no unmerged files found. Git stderr: ${mergeResult.stderr}`);
            return [];
        }
        const conflictPaths = conflictOutput.stdout.split("\n").filter(Boolean);
        const results = [];
        for (const filePath of conflictPaths) {
            const fullPath = join(worktreeDir, filePath);
            try {
                const stat = statSync(fullPath);
                if (stat.size > 512_000) {
                    results.push({ path: filePath, regions: [], oversized: true });
                    continue;
                }
            }
            catch {
                // File might be deleted in one side — binary conflict
                results.push({ path: filePath, regions: [], oversized: false });
                continue;
            }
            const content = readFileSync(fullPath, "utf-8");
            const regions = parseConflictMarkers(content);
            results.push({ path: filePath, regions, oversized: false });
        }
        return results;
    }
    finally {
        cleanupWorktree(gitRoot, worktreeDir);
    }
}
// ─── renderConflicts — markdown conflict report ──────────────────────────────
export async function renderConflicts(data, options) {
    const { pr } = data;
    const { gitRoot, outputPath, pullNumber } = options;
    // Check if PR has merge conflicts
    if (!(pr.mergeable === false && pr.mergeable_state === "dirty")) {
        // No conflicts — clean up stale conflict file if it exists
        try {
            await unlink(outputPath);
        }
        catch { /* didn't exist */ }
        return null;
    }
    const baseBranch = pr.base.ref;
    const headBranch = pr.head.ref;
    console.error(`Merge conflicts detected — running trial merge...`);
    let conflicts;
    try {
        conflicts = extractConflicts(gitRoot, baseBranch, headBranch, {
            baseSha: pr.base.sha,
            headSha: pr.head.sha,
            pullNumber,
        });
    }
    catch (e) {
        console.error(`Warning: Could not perform trial merge: ${e.message}`);
        // Write a minimal conflict report
        const minimal = `# ⚠ Merge Conflicts — PR #${pullNumber}\n\n\`${headBranch}\` cannot merge cleanly into \`${baseBranch}\`\n\nCould not perform local trial merge to extract conflict details.\nError: ${e.message}\n`;
        await writeFile(outputPath, minimal, "utf-8");
        return outputPath;
    }
    if (conflicts.length === 0) {
        console.error(`Trial merge found no conflicts (API may be stale).`);
        try {
            await unlink(outputPath);
        }
        catch { /* fine */ }
        return null;
    }
    const totalRegions = conflicts.reduce((s, f) => s + f.regions.length, 0);
    const out = [];
    const w = (line = "") => out.push(line);
    w(`# ⚠ Merge Conflicts — PR #${pullNumber}`);
    w();
    w(`\`${headBranch}\` cannot merge cleanly into \`${baseBranch}\``);
    w();
    w(`${conflicts.length} conflicting file${conflicts.length !== 1 ? "s" : ""} · ${totalRegions} conflict region${totalRegions !== 1 ? "s" : ""}`);
    w();
    w("---");
    for (const file of conflicts) {
        w();
        const regionCount = file.oversized ? "⚠ oversized" : `${file.regions.length} conflict${file.regions.length !== 1 ? "s" : ""}`;
        w(`## 📁 ${file.path}  ·  ${regionCount}`);
        w();
        if (file.oversized) {
            w(`> File exceeds 500KB — content not shown.`);
            w();
            continue;
        }
        if (file.regions.length === 0) {
            w(`> Binary or deleted-vs-modified conflict — no inline markers.`);
            w();
            continue;
        }
        const lang = langForFile(file.path);
        for (let r = 0; r < file.regions.length; r++) {
            const region = file.regions[r];
            w(`### Conflict ${r + 1} of ${file.regions.length} — Lines ${region.startLine}–${region.endLine}`);
            w();
            w(`> ${classifyConflict(region)}`);
            w();
            if (region.contextBefore.length > 0) {
                w("Context:");
                w("```");
                for (const cl of region.contextBefore)
                    w(cl);
                w("```");
                w();
            }
            w(`**⬅ BASELINE** (\`${baseBranch}\`):`);
            w("```" + lang);
            w(region.baseContent);
            w("```");
            w();
            if (region.ancestorContent !== undefined) {
                w(`**ANCESTOR** (common):`);
                w("```" + lang);
                w(region.ancestorContent);
                w("```");
                w();
            }
            w(`**➡ NEW** (\`${headBranch}\`):`);
            w("```" + lang);
            w(region.incomingContent);
            w("```");
            if (region.contextAfter.length > 0) {
                w();
                w("```");
                for (const cl of region.contextAfter)
                    w(cl);
                w("```");
            }
            w();
        }
        w("---");
    }
    // Summary table
    w();
    w("## Summary");
    w();
    w("| File | Conflicts | Regions |");
    w("|------|-----------|---------|");
    for (const file of conflicts) {
        if (file.oversized) {
            w(`| \`${file.path}\` | ⚠ oversized | — |`);
        }
        else if (file.regions.length === 0) {
            w(`| \`${file.path}\` | binary/delete | — |`);
        }
        else {
            const regionStrs = file.regions.map(r => `L${r.startLine}–${r.endLine}`).join(", ");
            w(`| \`${file.path}\` | ${file.regions.length} | ${regionStrs} |`);
        }
    }
    w();
    w(`**Total**: ${conflicts.length} file${conflicts.length !== 1 ? "s" : ""} · ${totalRegions} conflict region${totalRegions !== 1 ? "s" : ""}`);
    // Quick resolve section
    w();
    w("### Quick Resolve");
    w();
    w("To resolve all conflicts, specify a side per file:");
    w();
    const fileArgs = conflicts
        .filter(f => !f.oversized)
        .map(f => `--use-incoming ${f.path}`)
        .join(" ");
    w("```bash");
    w(`print-pr-review ${pullNumber} ${fileArgs}`);
    w("```");
    w();
    const output = out.join("\n");
    await writeFile(outputPath, output, "utf-8");
    console.error(`Written conflict report to ${outputPath} (${output.length} bytes)`);
    return outputPath;
}
// ─── Levenshtein distance ────────────────────────────────────────────────────
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0)
        return n;
    if (n === 0)
        return m;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++)
        dp[i][0] = i;
    for (let j = 0; j <= n; j++)
        dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[m][n];
}
function findClosestMatch(input, candidates) {
    // 1. Exact basename match
    const bn = basename(input);
    const basenameMatch = candidates.find(c => basename(c) === bn);
    if (basenameMatch)
        return basenameMatch;
    // 2. Levenshtein distance <= 3 on full path
    let best = null;
    let bestDist = Infinity;
    for (const c of candidates) {
        const d = levenshtein(input, c);
        if (d < bestDist && d <= 3) {
            bestDist = d;
            best = c;
        }
    }
    return best;
}
// ─── Commit message builder ──────────────────────────────────────────────────
function buildCommitMessage(prNumber, resolved) {
    const maxFileLen = Math.max(...resolved.map(r => r.file.length));
    const lines = resolved.map(r => `  ${r.file.padEnd(maxFileLen)}  → used ${r.side}`);
    return `Resolve merge conflicts — PR #${prNumber}\n\n${lines.join("\n")}`;
}
// ─── Conflict resolution: two-phase flow ─────────────────────────────────────
//
// Phase 1 (`validateInWorktree`): sandboxed merge in a tmp worktree. Builds
// the resolution plan with index-state fingerprints.
//
// Phase 2 (`applyResolutions`): replays the plan in the user's working tree.
//
// Direction (both phases): worktree starts on PR HEAD, BASE is merged in.
//   ours / stage 2 = PR head = "incoming"
//   theirs / stage 3 = base   = "baseline"
//
// `incoming` → stage 2, `baseline` → stage 3. When the chosen side has no
// stage (modify/delete), we stage a `git rm`. Resolution is verified by the
// unmerged index (`git ls-files -u`), not by byte-scanning for marker text.
/**
 * Apply each resolution to whichever working tree we're given (sandbox in
 * Phase 1, user's tree in Phase 2). Returns null on success, an error string
 * on failure. Mutates `plan` to fill in the index-state fingerprint per file.
 */
function applyPlanInWorkTree(workTree, plan) {
    for (const entry of plan) {
        const wantedStage = entry.side === "incoming" ? 2 : 3;
        const stages = getUnmergedStages(workTree, entry.path);
        const hasWanted = stages.some(s => s.stage === wantedStage);
        if (!hasWanted) {
            // Selected side deleted the file (modify/delete conflict).
            const rm = gitExecSafe(["rm", "-f", "--", entry.path], workTree);
            if (!rm.ok) {
                return `git rm failed for ${entry.path} (selected side deleted the file): ${rm.stderr}`;
            }
            entry.fingerprint = { kind: "deleted" };
            continue;
        }
        // checkout-index works straight off the index entries — handles symlinks,
        // executable modes, binaries, and submodules, which `git checkout --ours`
        // does not.
        const co = gitExecSafe(["checkout-index", "-f", `--stage=${wantedStage}`, "--", entry.path], workTree);
        if (!co.ok) {
            return `git checkout-index --stage=${wantedStage} failed for ${entry.path}: ${co.stderr}`;
        }
        const add = gitExecSafe(["add", "--", entry.path], workTree);
        if (!add.ok) {
            return `git add failed for ${entry.path}: ${add.stderr}`;
        }
        entry.fingerprint = getStagedFingerprint(workTree, entry.path);
    }
    // Verify by reading the unmerged index — files may legitimately contain
    // `<<<<<<<` literally (this codebase, for one), so byte-scanning is wrong.
    for (const entry of plan) {
        const remaining = getUnmergedStages(workTree, entry.path);
        if (remaining.length > 0) {
            return `Resolution did not clear unmerged stages for ${entry.path}. Possible nested conflict.`;
        }
    }
    return null;
}
// ─── Phase 1: validate in tmp worktree ───────────────────────────────────────
export function validateInWorktree(gitRoot, base, head, resolutions, prSpec = { pullNumber: 0 }) {
    // Prune stale worktree state from previous runs (killed processes etc.).
    gitExecSafe(["worktree", "prune"], gitRoot);
    const worktreeDir = allocWorktreeDir(gitRoot, "resolve");
    try {
        const refs = fetchPrRefs(gitRoot, base, head, {
            baseSha: prSpec.baseSha, headSha: prSpec.headSha, pullNumber: prSpec.pullNumber,
        });
        // Worktree at PR HEAD; merge BASE into it (the correct direction for a
        // commit that lives on the PR head branch).
        gitExec(["worktree", "add", "--detach", worktreeDir, refs.headSha], gitRoot);
        const mergeResult = gitExecSafe(["merge", "--no-commit", "--no-ff", refs.baseSha], worktreeDir);
        if (mergeResult.ok) {
            return {
                status: "validated", conflictFiles: [], resolutionPlan: [],
                skipped: [], warnings: ["No conflicts found — PR merges cleanly."],
            };
        }
        const conflictOutput = gitExecSafe(["diff", "--name-only", "--diff-filter=U"], worktreeDir);
        const conflictFiles = (conflictOutput.stdout || "").split("\n").filter(Boolean);
        if (conflictFiles.length === 0) {
            return {
                status: "failed", conflictFiles: [], resolutionPlan: [],
                skipped: [], warnings: [],
                error: `Merge failed for non-conflict reasons: ${mergeResult.stderr}`,
            };
        }
        const conflictSet = new Set(conflictFiles);
        const resolutionPlan = [];
        const warnings = [];
        for (const [file, side] of resolutions) {
            if (!conflictSet.has(file)) {
                const closest = findClosestMatch(file, conflictFiles);
                warnings.push(closest
                    ? `⚠ ${file} has no conflicts. Did you mean \`${closest}\`?`
                    : `⚠ ${file} has no conflicts, flag ignored`);
                continue;
            }
            resolutionPlan.push({
                path: file, side, fingerprint: { kind: "deleted" },
            });
        }
        if (resolutionPlan.length === 0 && resolutions.size > 0) {
            return {
                status: "failed", conflictFiles, resolutionPlan: [],
                skipped: conflictFiles, warnings,
                error: "No valid resolution flags — all specified files either have no conflicts or were not found.",
            };
        }
        const applyErr = applyPlanInWorkTree(worktreeDir, resolutionPlan);
        if (applyErr) {
            return {
                status: "failed", conflictFiles, resolutionPlan, skipped: [],
                warnings, error: applyErr,
            };
        }
        const resolvedPaths = new Set(resolutionPlan.map(r => r.path));
        const skipped = conflictFiles.filter(f => !resolvedPaths.has(f));
        return { status: "validated", conflictFiles, resolutionPlan, skipped, warnings };
    }
    catch (err) {
        return {
            status: "failed", conflictFiles: [], resolutionPlan: [],
            skipped: [], warnings: [], error: err.message || String(err),
        };
    }
    finally {
        cleanupWorktree(gitRoot, worktreeDir);
    }
}
// ─── Phase 2: apply in the user's working tree ───────────────────────────────
export function applyResolutions(opts, validation) {
    const { gitRoot, base, head, pullNumber } = opts;
    // Pre-flight: detached HEAD → no branch to commit on.
    const headRef = gitExecSafe(["symbolic-ref", "HEAD"], gitRoot);
    if (!headRef.ok) {
        return {
            status: "aborted",
            error: "✗ HEAD is detached. Check out the PR's head branch before resolving conflicts.",
        };
    }
    // Pre-flight: bare repo has no working tree.
    const isBare = gitExecSafe(["rev-parse", "--is-bare-repository"], gitRoot);
    if (isBare.stdout === "true") {
        return {
            status: "aborted",
            error: "✗ This is a bare repository. Conflict resolution requires a working tree.",
        };
    }
    // Pre-flight: clean working tree. (Pre-existing unfinished merge state is
    // checked below; this catches uncommitted edits in tracked files.)
    const status = gitExecSafe(["status", "--porcelain"], gitRoot);
    if (status.stdout.length > 0 && !mergeAlreadyInProgress(gitRoot)) {
        return {
            status: "aborted",
            error: "✗ Working tree has uncommitted changes. Commit or stash them first.",
        };
    }
    // Re-fetch and verify refs into the private namespace before committing.
    // Even though Phase 1 already fetched, we re-verify to surface ref movement
    // between phases as a hard error rather than silently committing the wrong
    // merge.
    let refs;
    try {
        refs = fetchPrRefs(gitRoot, base, head, {
            baseSha: opts.baseSha, headSha: opts.headSha, pullNumber,
        });
    }
    catch (e) {
        return { status: "aborted", error: `✗ ${e.message}` };
    }
    // Verify the user's current branch is on the PR head — i.e. committing on
    // it actually updates the PR. This is the fix for the prior bug where a
    // merge from `base` produced a commit on `base`.
    const userHeadSha = gitExec(["rev-parse", "HEAD"], gitRoot);
    if (userHeadSha !== refs.headSha) {
        const branchName = headRef.stdout.replace(/^refs\/heads\//, "");
        return {
            status: "aborted",
            error: `✗ Current branch (${branchName} at ${userHeadSha.slice(0, 12)}) is not at the PR head ` +
                `(${refs.headSha.slice(0, 12)}). Check out the PR head branch and ensure it's up to date:\n` +
                `    git fetch origin\n` +
                `    git checkout ${head} && git reset --hard ${refs.headSha}\n` +
                `  (or use \`gh pr checkout ${pullNumber}\`)`,
        };
    }
    // Start (or resume) the merge in the user's working tree.
    if (!mergeAlreadyInProgress(gitRoot)) {
        const mergeResult = gitExecSafe(["merge", "--no-commit", "--no-ff", refs.baseSha], gitRoot);
        if (mergeResult.ok) {
            // No conflicts after all — abort the clean merge to leave the tree as
            // we found it.
            gitExecSafe(["merge", "--abort"], gitRoot);
            return { status: "no_conflicts" };
        }
    }
    // Replay each validated resolution in the user's working tree.
    const replayPlan = validation.resolutionPlan.map(r => ({
        path: r.path, side: r.side, fingerprint: { kind: "deleted" },
    }));
    const applyErr = applyPlanInWorkTree(gitRoot, replayPlan);
    if (applyErr) {
        gitExecSafe(["merge", "--abort"], gitRoot);
        return {
            status: "aborted",
            error: `✗ ${applyErr}. Merge aborted — working tree restored.`,
        };
    }
    // Verify the user-tree fingerprints match the sandbox plan — if they don't,
    // the branches moved between phases and we should not commit.
    for (let i = 0; i < replayPlan.length; i++) {
        const expected = validation.resolutionPlan[i].fingerprint;
        const actual = replayPlan[i].fingerprint;
        if (expected.kind !== actual.kind ||
            expected.oid !== actual.oid ||
            expected.mode !== actual.mode) {
            gitExecSafe(["merge", "--abort"], gitRoot);
            return {
                status: "aborted",
                error: `✗ Resolution fingerprint mismatch for ${replayPlan[i].path}. ` +
                    `Sandbox produced ${JSON.stringify(expected)}, ` +
                    `working tree produced ${JSON.stringify(actual)}. ` +
                    `The branches likely moved between validation and apply — merge aborted, working tree restored.`,
            };
        }
    }
    // Re-verify SHAs one last time before committing.
    const baseStill = gitExec(["rev-parse", refs.baseRef], gitRoot);
    const headStill = gitExec(["rev-parse", refs.headRef], gitRoot);
    if (baseStill !== refs.baseSha || headStill !== refs.headSha) {
        gitExecSafe(["merge", "--abort"], gitRoot);
        return {
            status: "aborted",
            error: "✗ Refs moved between fetch and commit. Merge aborted — re-run to retry.",
        };
    }
    const resolved = replayPlan.map(r => ({ file: r.path, side: r.side }));
    // If the user only specified some of the conflicting files, leave the
    // merge in progress so they can resolve the rest by hand.
    if (validation.skipped.length > 0) {
        return {
            status: "partial",
            resolved,
            skipped: validation.skipped,
            warnings: validation.warnings,
        };
    }
    const commitMsg = buildCommitMessage(pullNumber, resolved);
    gitExec(["commit", "--no-edit", "-m", commitMsg], gitRoot);
    const newCommit = gitExec(["rev-parse", "HEAD"], gitRoot);
    return {
        status: "committed",
        resolved,
        warnings: validation.warnings,
        commitMessage: commitMsg,
        commitSha: newCommit,
        pushHint: { branch: head },
    };
}
function mergeAlreadyInProgress(workTree) {
    // Worktree-safe: don't peek at <root>/.git/MERGE_HEAD as a file path, since
    // `<root>/.git` is a gitfile in linked worktrees.
    const r = gitExecSafe(["rev-parse", "-q", "--verify", "MERGE_HEAD"], workTree);
    return r.ok && r.stdout.length > 0;
}
// ─── resolveConflicts — orchestration ────────────────────────────────────────
export function resolveConflicts(opts) {
    // Single command — internally: validate in a tmp worktree, then apply to
    // the user's working tree. There is no separate "dry-run" mode.
    process.stderr.write(`Validating resolutions in sandbox worktree...\n`);
    const validation = validateInWorktree(opts.gitRoot, opts.base, opts.head, opts.resolutions, { baseSha: opts.baseSha, headSha: opts.headSha, pullNumber: opts.pullNumber });
    for (const w of validation.warnings) {
        process.stderr.write(`${w}\n`);
    }
    if (validation.status === "failed") {
        process.stderr.write(`\n✗ ${validation.error}\n`);
        process.stderr.write(`  Your working tree was NOT modified.\n`);
        return { status: "aborted", error: validation.error };
    }
    if (validation.resolutionPlan.length === 0) {
        process.stderr.write(`No conflicts to resolve.\n`);
        return { status: "no_conflicts" };
    }
    process.stderr.write(`\n✓ Validation passed:\n`);
    for (const r of validation.resolutionPlan) {
        process.stderr.write(`  ${r.path}  → will use ${r.side}\n`);
    }
    if (validation.skipped.length > 0) {
        process.stderr.write(`  (${validation.skipped.length} file${validation.skipped.length !== 1 ? "s" : ""} skipped — no flag specified)\n`);
    }
    process.stderr.write(`\nApplying to your working tree...\n`);
    const result = applyResolutions(opts, validation);
    if (result.status === "committed") {
        process.stderr.write(`\n✓ Resolved ${result.resolved.length} conflict${result.resolved.length !== 1 ? "s" : ""}:\n`);
        for (const r of result.resolved) {
            process.stderr.write(`  ${r.file}  → used ${r.side}\n`);
        }
        process.stderr.write(`\n✓ Committed ${result.commitSha?.slice(0, 12)} on ${opts.head}\n`);
        process.stderr.write(`→ Run: git push origin ${opts.head} when ready\n`);
    }
    else if (result.status === "partial") {
        process.stderr.write(`\n✓ Resolved ${result.resolved.length} of ${result.resolved.length + result.skipped.length} conflicts:\n`);
        for (const r of result.resolved) {
            process.stderr.write(`  ${r.file}  → used ${r.side}\n`);
        }
        process.stderr.write(`\n⚠ Skipped — no resolution specified (merge is left in progress):\n`);
        for (const s of result.skipped) {
            process.stderr.write(`  ${s}\n`);
        }
        process.stderr.write(`\n→ Resolve remaining conflicts, then run:\n`);
        process.stderr.write(`  git add ${result.skipped.join(" ")} && git merge --continue\n`);
    }
    else if (result.status === "aborted") {
        process.stderr.write(`\n✗ ${result.error}\n`);
    }
    return result;
}
