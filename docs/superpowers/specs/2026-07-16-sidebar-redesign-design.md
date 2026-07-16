# Sidebar (left pane) visual redesign

## Problem

The sidebar (`Sidebar.tsx`) and its embedded new-worktree form (`NewWorktreeForm.tsx`)
use unstyled native `<button>`/`<input>` elements, plain-text glyphs (`●`/`▸`/`✕`) for
status and actions, always-visible remove icons, and a flat list that doesn't visually
group worktrees by repo when multiple repos are connected. Against the app's polished
dark/glass backdrop, this reads as unfinished and is harder to scan than it should be.

`ConfirmModal.tsx`'s Confirm/Cancel buttons have the same unstyled-native-button problem
and are included in this pass so button styling is consistent app-wide.

## Non-goals

- No new dependencies (no icon library) — icons are hand-written inline SVG.
- No changes to `DiffPanel.tsx`, `TerminalView.tsx`, or terminal styling.
- No changes to app data flow, IPC, or state shape (`store.ts` untouched) — this is
  presentational only. The worktree list is already produced in repo order; grouping
  is a rendering change, not a data change.
- No changes to tooltip *behavior*, only minor style polish to match the new palette.

## Design

### 1. Structure: repo-grouped list

Remove the standalone "connected repos" block (lines ~78–95 of `Sidebar.tsx`). Instead,
group `worktrees` by `repoName` (preserving existing repo order, since `worktrees` is
already built repo-by-repo in `refreshWorktreeList`) and render one section per repo:

- A header row: repo folder name, small-caps/muted style, with a "✕ disconnect" action
  that is only rendered visibly on row hover (kept in the DOM but opacity 0 → 1 on
  `:hover` via a wrapping element's hover state, matching the pattern used for
  per-worktree remove buttons).
- That repo's worktrees rendered below, indented slightly (~4px extra left padding)
  relative to the header.
- Repos with zero worktrees still render their header (so a freshly-added repo with no
  worktrees isn't silently missing) followed by nothing.

If there is exactly one repo connected, the header still renders (consistency over a
special case), but it's low-contrast enough not to feel redundant.

### 2. Row treatment

- Replace `●` (main) / `▸` (other) text glyphs with small inline SVG icons: a filled
  circle for the main worktree, a simple branch glyph for others. ~10px, currentColor
  stroke/fill so they inherit text color and work in selected/hover states without
  extra color logic.
- Selected row: replace the solid `#094771` block background with a 2–3px accent-colored
  left border plus a soft tinted background (accent at low opacity over the existing
  translucent row background).
- Add a hover background (subtle lighten, distinct from and lighter than the selected
  tint) on non-selected rows.
- Remove ("✕") icon: only visible on row hover or when the row is selected; otherwise
  invisible (not removed from layout, to avoid content shift) via opacity.
- Change-count badge: keep amber but soften into a pill consistent with the new button
  radius/weight conventions (see §4).

### 3. Buttons & inputs

Introduce one small shared style convention (as inline style objects/helpers local to
these files — no new shared component needed given the scope):

- **Primary** (filled): accent background, white text, used for "+ WT" and modal
  Confirm.
- **Secondary/ghost** (outlined/transparent): subtle border, transparent background,
  hover fills lightly. Used for "+ Repo" and modal Cancel.
- **Danger**: same shape as primary, red background — used for destructive Confirm
  (already exists in `ConfirmModal`, just restyled to match the new shape/radius).
- Inputs (branch-name field in `NewWorktreeForm`): dark translucent background matching
  the glass aesthetic, subtle border, focus ring in the accent color, consistent radius
  with buttons.

All four buttons in scope (`+ Repo`, `+ WT`, modal `Cancel`, modal `Confirm`) and the one
input in scope (`branch` field) apply this convention. No new abstraction beyond plain
style objects — this is 2 files' worth of buttons, not worth a `<Button>` component yet.

### 4. Color

No new hues. Reuse what's already in the app:

- Accent (selection, primary buttons, focus rings): the existing blue family
  (`#0e639c`-ish, currently used for ConfirmModal's non-danger Confirm button).
- Danger: existing red (`#a1260d`/`#f28b82` family, already used in ConfirmModal).
- Status/change-count badge: existing amber (`#c93`/`#c9a26a` family, already used in
  DiffPanel for modified files).
- Text/border grays: keep existing `#ddd`/`#888`/`#333`/`#444`.

## Files touched

- `src/renderer/components/Sidebar.tsx` — structure, row treatment, repo grouping,
  "+ Repo" button restyle.
- `src/renderer/components/NewWorktreeForm.tsx` — input + "+ WT" button restyle.
- `src/renderer/components/ConfirmModal.tsx` — Confirm/Cancel button restyle only.

## Testing

Presentational-only change. Verify manually in the running app (`run` skill or existing
dev workflow):
- Single repo, multiple worktrees: header renders, list scans cleanly, selection/hover
  states look right.
- Multiple repos: each repo's group is visually distinct, disconnect action appears on
  header hover.
- Zero worktrees / zero repos: empty state still renders correctly.
- Remove-worktree and disconnect-repo confirm modals: buttons match new style, danger
  variant still reads as destructive.
- Long branch/repo names: ellipsis truncation still works (unchanged logic, just
  confirm no regression from added indentation/padding).
