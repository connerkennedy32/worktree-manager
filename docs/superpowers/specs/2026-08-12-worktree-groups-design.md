# Worktree Groups, Drag-and-Drop, and Hiding

Date: 2026-08-12

## Problem

The sidebar lists every worktree in a fixed order: repo sections in `repos.json`
order, worktrees within a repo in git's order. With many worktrees this becomes
hard to scan, and there is no way to set aside ones that are not currently
interesting.

## Goal

Let the user organize the sidebar: create named groups spanning repos, drag
worktrees and groups into any order, and hide worktrees that are not in use.

## Data model

A new `userData/layout.json`, read and written in `src/main/config.ts` alongside
`names.json`, exposed over IPC as `getLayout()` / `setLayout(layout)`:

```ts
interface Layout {
  groups: { id: string; name: string; collapsed: boolean; paths: string[] }[]
  hidden: string[]          // worktree paths in the Hidden section
  hiddenCollapsed: boolean
}
```

Rules:

- `groups` order is display order; each group's `paths` order is row order inside it.
- A worktree path appears in at most one place — one group, or `hidden`, or neither.
- Anything not in `groups` and not in `hidden` renders under its repo section at
  the bottom, in git's order (today's behavior).
- Paths whose worktrees no longer exist are ignored at render time but kept in
  the file, so a temporarily-missing worktree does not lose its group. A path is
  purged only when its repo is disconnected.
- Groups do not nest. A group may hold worktrees from different repos.

The store holds `layout` plus a derived selector producing the rendered sections
and a flat nav order. `selectRelative` (Cmd+Up/Down) walks that same flat order,
so keyboard nav follows what is on screen: it skips collapsed groups and skips
the Hidden section while collapsed.

Writes are full-file, like `names.json`. The renderer sets state optimistically
and then fires `setLayout`.

## UI

Sidebar structure, top to bottom:

1. Header: `WORKTREES` · `+ Group` · `+ Repo`
2. Custom groups in user order — collapsible header (`▸ Name  3`) plus rows
3. Repo sections (existing headers, with the disconnect ✕) holding everything ungrouped
4. `Hidden (N)` — collapsed by default, at the very bottom

Group management:

- `+ Group` appends a group named "New group" already in inline-edit mode,
  reusing the existing `wt-input` inline rename pattern used for rows.
- Double-click a group header to rename.
- ✕ on hover deletes the group only; its worktrees fall back to their repo sections.
- Click the header to collapse/expand. The count badge shows how many rows are
  inside, so a collapsed group still conveys size.

Dragging (native HTML5 drag-and-drop; no new dependency — the app is Chromium-only):

- Worktree rows and group headers are both `draggable`.
- Dragging a row shows a 1px accent insertion line at the nearest row boundary.
- Valid drop zones for a row: any group body, any repo section, the Hidden section.
- Dropping into a repo section removes the worktree from its group; repo sections
  stay in git order and are not manually sortable — ordering is what groups are for.
- Dragging a group header reorders whole groups.
- Repo sections are not draggable; their order stays `repos.json` order.

Hiding:

- An eye icon appears next to the ✕ on row hover and moves the row into Hidden.
- Inside Hidden, rows show an un-hide icon and can also be dragged back out.
- Hidden rows keep their agent-status dot and change badge, so an expanded Hidden
  section still surfaces activity. While collapsed they contribute nothing and are
  skipped by Cmd+Up/Down.

Selection is unchanged. If the selected worktree is hidden, it stays selected and
its terminal stays open; the collapsed Hidden header simply does not show it.

## Components

`Sidebar.tsx` is 244 lines today and this roughly doubles it, so split:

- `src/renderer/components/Sidebar.tsx` — section layout, modals, tooltip (shrinks)
- `src/renderer/components/WorktreeRow.tsx` — one row: icon/dot, inline rename,
  badge, hide and remove actions, drag handlers
- `src/renderer/components/sidebar-layout.ts` — pure, no React. Given `layout`,
  `worktrees`, and `repos`, produces the rendered sections and the flat nav order.
  Also holds the layout mutations: `moveTo(path, target, index)`, `addGroup`,
  `renameGroup`, `deleteGroup`, `hide`, `unhide`, `reorderGroup`. This is where
  the logic lives and where the tests point.
- `src/main/config.ts` — `readLayout` / `writeLayout`, matching the `names.json` shape.

## Error handling

Layout is cosmetic and fails soft everywhere:

- Unreadable or corrupt `layout.json` yields an empty layout (repo sections only),
  using the same `try/catch` pattern as `listNames`.
- A failed `setLayout` write logs and leaves in-memory state as-is rather than
  reverting the drag under the user's cursor; the next successful write repairs
  the file.
- Drops onto an invalid target are no-ops.

## Testing

Vitest, matching the existing `tests/` layout.

`tests/renderer/sidebar-layout.test.ts`:

- Derivation: ungrouped worktrees fall to their repo section; paths for missing
  worktrees are ignored but preserved; a path never renders twice.
- Every mutation: move between groups, move to repo section, move to Hidden,
  add/rename/delete group, reorder groups, hide/unhide.
- Flat nav order with collapsed groups and with Hidden collapsed and expanded.

`tests/main/config.test.ts` additions:

- Layout round-trips through `writeLayout` / `readLayout`.
- Missing file returns an empty layout.
- Corrupt JSON returns an empty layout rather than throwing.
- Disconnecting a repo purges that repo's paths from groups and hidden.

## Out of scope

Nested groups, multi-select drag, per-group colors or icons, syncing layout
across machines.
