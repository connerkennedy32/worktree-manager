# Committed-files section in the changes panel

## Problem

`DiffPanel` builds its file list entirely from `git status --porcelain` (see
`src/main/git/status.ts` and the `rows` memo in
`src/renderer/components/DiffPanel.tsx`). Once the user commits, the working tree
is clean, so the panel shows "No changes" and the branch's work becomes
invisible. There is no way to see what the branch has changed relative to its
base.

## Goal

Add a collapsible section listing the files the branch has committed against the
main worktree's branch, alongside the existing working-tree list.

## Base branch resolution

The base is the branch checked out in the repo's **main worktree**, not a
hardcoded `main`/`origin/main`. Resolution:

1. `git rev-parse --path-format=absolute --git-common-dir` in the worktree; the
   common dir's parent is the main worktree path. This is the pattern already
   used by `removeWorktree` in `src/main/git/worktrees.ts`.
2. Call the existing `listWorktrees(repoPath)` and take the entry with
   `isMain === true`; its `branch` is the base.

If the base branch equals the worktree's current branch (i.e. the user selected
the main worktree itself), there is nothing to compare — return an empty result.

## File list

`git diff --name-status <base>...HEAD` — three-dot, so the comparison is against
the merge base. Only what this branch changed since it diverged appears; commits
landing on the base afterward do not. This matches what a GitHub PR shows.

`--name-status` returns status letter + path per line, with renames as
`R100<TAB>old<TAB>new`. Parsing takes the final path, consistent with how
`getStatus` handles `->` renames. No patches are computed here — the list stays
as cheap as the working-tree list.

## IPC surface

New channel `getCommittedFiles: 'diff:committed'`.

```ts
export interface CommittedFile { path: string; code: string }
export interface CommittedChanges { baseBranch: string; files: CommittedFile[] }
// Api: getCommittedFiles(worktreePath: string): Promise<CommittedChanges>
```

An empty `files` array means "nothing to show" (main worktree, or no divergence).

Per-file patches reuse the existing lazy-load path rather than duplicating it:
`FileDiffRequest` gains an optional `baseRef?: string`. When present,
`getFileDiff` runs `git diff <baseRef>...HEAD -- <path>`; otherwise its current
staged/unstaged/untracked behavior is unchanged.

## Renderer

`DiffPanel` gains `committed: CommittedChanges | null` (`null` meaning "not
fetched yet") and a `committedOpen: boolean` (default `false`) in state. It fetches
`getCommittedFiles` in the same `useEffect` that calls `refreshStatus(selected)`,
and again after `doCommit`, so the list repopulates the instant the working list
empties.

Below the working file list sits a header row:
`▸ Committed vs <baseBranch> (N)`. Expanded, it renders the same row markup as
working files — status letter, click-to-expand lazy diff — with no Stage button,
since staging a committed file is meaningless. Row keys use a `:c` suffix so they
cannot collide with the existing `:s` / `:w` / `:u` keys. Expanding a committed
row calls `getFileDiff` with `baseRef` set.

The section is hidden entirely when `files` is empty.

`stagedCount` / `total` in the panel header and the collapsed-rail `CHANGES (N)`
badge continue to count working-tree rows only — committed files are not pending
work and must not inflate that count.

## Error handling

Base resolution is best-effort. Any throw (bare repo, no main worktree, detached
HEAD with no comparable base) resolves to an empty `CommittedChanges` and the
section hides. A failure here must never break the working-tree list, which is
the panel's primary function.

## Testing

`tests/git/committed.test.ts`, following the `makeTmpRepo` pattern in
`tests/git/`:

- Resolves the base branch from the main worktree and lists files committed on a
  linked worktree's branch.
- Three-dot semantics: a commit made on the base branch *after* divergence does
  not appear in the linked worktree's list.
- Rename status parsing yields the new path.
- The main worktree itself returns an empty list.
- `getFileDiff` with `baseRef` returns the committed patch for a single file.

Rendering is a straight reuse of existing row markup and is not separately
tested.

## Out of scope

- Choosing a base other than the main worktree's branch.
- Viewing or acting on individual commits (amend, revert, reorder).
- Push/PR actions.
