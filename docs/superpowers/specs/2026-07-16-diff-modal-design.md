# Diff Modal Design

Date: 2026-07-16

## Problem

Diffs currently render inline inside `DiffPanel`, expanded under each file row in a
460px column. That column is too narrow to read a diff comfortably, and side-by-side
view is impossible at that width. Reviewing a change means expanding rows one at a
time in a cramped space.

## Goal

Clicking a file in the changes panel opens a full-app modal that renders the diff
with room to breathe, lets the user move between files without closing it, and
toggles between inline and side-by-side rendering. The toggle sticks.

## Decisions

- The modal overlays the entire app, not just the panel area.
- The modal carries its own file list, so files can be browsed without closing it.
- Inline expansion in the panel is removed entirely. The quick-peek is deliberately
  given up; the panel becomes a launcher and commit surface.
- Stage/unstage is available in the modal as well as the panel.
- The inline/side-by-side choice persists across files and app restarts. Default on
  first run is side-by-side.
- The view preference lives in renderer `localStorage`, not `config.ts`. `config.ts`
  stores only the repo list and is main-process code reached over IPC; a purely
  visual preference does not justify that plumbing.

## Architecture

### Shared state: `src/renderer/state/store.ts`

Add:

```ts
openDiff: DiffTarget | null
setOpenDiff: (t: DiffTarget | null) => void
```

where `DiffTarget` is declared in `store.ts` (renderer-only state, so it does not
belong in `@shared/ipc-types`) as `{ key, path, staged, untracked, committed }` — the fields
`getFileDiff` needs, matching today's `Row` shape minus the display-only `code`.
`null` means the modal is closed.

The panel sets it, the modal reads it. It lives in the store rather than as `App.tsx`
props because both components need it and the panel is not the modal's parent.

### Shared row building: `useChangedFiles(selected)`

The row-derivation `useMemo` currently inside `DiffPanel` (status files → staged /
unstaged rows, plus the committed rows from `getCommittedFiles`) moves into a hook
that both `DiffPanel` and `DiffModal` call. Both surfaces render the same three
groups; duplicating the logic would let the two lists drift apart the first time
either changes.

The hook returns `{ stagedRows, unstagedRows, committedRows, committed, stagedCount, total }`.

### `src/renderer/components/DiffModal.tsx` (new)

Rendered from `App.tsx` — not from inside `DiffPanel` — so its geometry is not
constrained by the panel's column. Returns `null` when `openDiff` is `null`.

Layout:

- Backdrop: `position: fixed; inset: 0`, translucent black, click closes.
- Container: near-full viewport, dark surface consistent with `ConfirmModal`
  (`#2d2d2d`, `1px solid #444`, radius 6).
- Header: branch name left; Inline / Side-by-side segmented toggle and close X right.
- Left rail (~260px): Staged / Unstaged / Committed groups, each row showing status
  letter, path, and a stage/unstage button. Active file highlighted. Committed rows
  have no stage button, matching the panel's existing rule.
- Right pane: the diff, scrollable.

Dismissal: Escape key, backdrop click, close X.

Diff rendering uses `react-diff-view` with `viewType={view}` where `view` is
`'unified' | 'split'`. That prop is the entire inline/side-by-side mechanism — no
second rendering path.

Patch fetching reuses `window.api.getFileDiff({ worktreePath, path, staged,
untracked, baseRef })`, with `baseRef` set to the committed base branch for committed
rows, as `DiffPanel` does today. Patches cache in a `Record<string, string>` keyed by
row key and are cleared on stage/unstage, since staging invalidates the
staged/unstaged split.

Stage/unstage in the modal calls the same `window.api.stagePath` + `refreshStatus`
sequence the panel uses.

View preference: read `localStorage.getItem('diffView')` on mount, falling back to
`'split'`; write on each toggle.

### `src/renderer/components/DiffPanel.tsx` (changed)

Removed: the `expanded` Set, `patches` state, `fetchPatch`, `toggle`, the
`parseDiff` / `Diff` / `Hunk` imports, `react-diff-view` CSS imports, the expand
caret, and the inline diff block in `renderRow`.

Kept: section headers with open/closed state, the commit textarea and button, the
collapsed rail, the header counts.

Changed: `renderRow` becomes status letter + path + stage button; clicking the row
calls `setOpenDiff(row)`. Row-list derivation comes from `useChangedFiles`.

## Data flow

1. Panel renders rows from `useChangedFiles(selected)`.
2. Click a row → `setOpenDiff(row)`.
3. `App.tsx` sees `openDiff` non-null → renders `DiffModal`.
4. Modal renders its rail from the same hook, fetches the patch for `openDiff`,
   renders it at `viewType`.
5. Clicking a rail row → `setOpenDiff(otherRow)` → patch fetched (or served from
   cache) → diff swaps in place.
6. Stage/unstage anywhere → `stagePath` → `refreshStatus` → both lists re-derive from
   the refreshed status; patch cache clears.
7. Escape / backdrop / X → `setOpenDiff(null)` → modal unmounts.

## Error handling

- Patch not yet fetched: "Loading…" in the diff pane.
- Patch present but `parseDiff` yields nothing (binary or empty): "No textual diff
  (binary or empty)." — same copy as today.
- `parseDiff` throws: caught, treated as the empty case, as today.
- The open file disappears from the file list (e.g. staged away, or status refreshed
  out from under it): the modal closes via `setOpenDiff(null)` rather than rendering
  a stale diff.

## Testing

The existing suite covers `src/main/git/*` (diff, status, committed) and none of the
renderer; this change touches no main-process code and adds no IPC, so those tests
should stay green untouched — a regression there means something unintended changed.

Verification is manual, through the running app:

- Click a file in each of the three sections; the modal opens on that file.
- Toggle inline / side-by-side; the same diff re-renders in both.
- Reopen the modal and restart the app; the toggle choice persists.
- Click through rail files; diffs swap without the modal closing.
- Stage from the modal; the file moves between groups in both the rail and the panel.
- Escape, backdrop click, and X each close it.

## Out of scope

- Quick-peek / inline expansion in the panel (deliberately removed).
- Per-hunk or per-line staging.
- Syntax highlighting inside the diff.
- Word-level intra-line diff highlighting.
