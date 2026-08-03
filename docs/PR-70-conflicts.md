# ⚠ Merge Conflicts — PR #70

`worktree-edit-tool` does not merge cleanly into `main`

**1** conflicting file · **1** conflict region

**OURS** = your branch (`main`)
**THEIRS** = incoming (`worktree-edit-tool`)
**BASE** = common ancestor _(shown only with diff3 / zdiff3 conflict style)_

Gutter shows per-side real file line numbers — ours on `-`/context, theirs on `+`, base on the ancestor block; conflict markers are unnumbered.

---

## 📁 `packages/zenith-mcp/src/core/db-adapter.ts`  ·  1 conflict

### Conflict 1 of 1 · ours L707–708

> ⚡ Both sides edited this span (ancestor shown).

```diff
704       // Build name → index lookup
705       const nameToIndex = new Map<string, number>();
706       for (let i = 0; i < blockNames.length; i++) {
     <<<<<<< OURS · main ═══════════════════════════════════════════════
707 -         const blockName = blockNames[i];
708 -         if (blockName !== undefined) nameToIndex.set(blockName, i);
     ||||||| BASE · common ancestor ────────────────────────────────────
658           nameToIndex.set(blockNames[i]!, i);
     ======= THEIRS · worktree-edit-tool ═══════════════════════════════
670 +         const name = blockNames[i];
671 +         if (name !== undefined) nameToIndex.set(name, i);
     >>>>>>> END ═══════════════════════════════════════════════════════
709       }
710
711       // Query all edges where the caller is a definition in this file
```

---

## Summary

| File | Conflicts | Lines |
|------|-----------|-------|
| `packages/zenith-mcp/src/core/db-adapter.ts` | 1 | ours L707–708 |

**Total:** 1 file · 1 conflict region

### Quick Resolve

Accept the incoming side for every file (swap to `--use-baseline` per file as needed):

```bash
git-print 70 --use-incoming packages/zenith-mcp/src/core/db-adapter.ts
```
