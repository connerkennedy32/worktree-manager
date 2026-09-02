# PR Status Indicator Per Worktree — Design

**Date:** 2026-08-13

## Goal

Show each worktree's GitHub pull request state as a small colored dot in the
sidebar row, refreshed on demand.

## User decisions

- **Refresh:** manual only. One button in the sidebar header refreshes every
  worktree at once. No polling, no refresh-on-push, no refresh-on-focus.
- **Indicator:** a colored dot before the worktree name, with a tooltip like
  `PR #123 · Approved`. Nothing renders when there is no PR.
- **States:** draft, in review, changes requested, approved, merged, closed
  (closed without merge), plus `none`.
- **Persistence:** last-known status is cached to disk so dots appear
  immediately at launch.

## Data source

The `gh` CLI, run with `cwd` set to the worktree:

```
gh pr view --json number,url,isDraft,state,reviewDecision
```

`gh` resolves both the repository and the branch from the working directory, so
no remote parsing or branch plumbing is needed. Exit code 1 with a "no pull
requests found" stderr means no PR — a normal outcome, not an error.

If `gh` is missing or unauthenticated the feature no-ops: no dots appear, and
the refresh button's tooltip explains why.

## State derivation

Pure function `derivePrState(raw)` in `src/shared/pr-status.ts`, precedence in
order:

1. `state === 'MERGED'` → `merged`
2. `state === 'CLOSED'` → `closed`
3. `isDraft` → `draft`
4. `reviewDecision === 'APPROVED'` → `approved`
5. `reviewDecision === 'CHANGES_REQUESTED'` → `changesRequested`
6. otherwise → `review`

Draft outranks review decision: a draft PR is a draft regardless of any stray
review. Merged/closed outrank draft because the PR's life is over either way.

## Architecture

```
src/shared/pr-status.ts        PrState, PrStatus, derivePrState, PR_STATE_LABEL  (pure, tested)
src/main/github/gh.ts          resolveGh(), runGh() — locating and invoking the CLI
src/main/github/pr-status.ts   fetchPrStatus(path, run), refreshAll(paths, run)  (concurrency 6)
src/main/config.ts             readPrStatuses() / writePrStatuses()  → userData/pr-status.json
src/main/ipc.ts                pr:get, pr:refresh handlers
src/preload/index.ts           Api passthrough
src/renderer/state/store.ts    prStatuses, prError, prRefreshing, refreshPrStatuses()
WorktreeRow.tsx                the dot
Sidebar.tsx                    the refresh button
sidebar-theme.css              dot colors
```

Cache is keyed by absolute worktree path, matching how the renderer indexes
everything else. Entries whose worktree directory no longer exists are pruned
on write, so the file doesn't grow forever.

`refreshAll` runs one `gh` call per worktree with a concurrency cap of 6. One
call per worktree is exact and, with manual refresh, the volume is trivial.

## Error handling

- No PR for the branch → `{ state: 'none' }`, cached like any other result.
- `gh` not found or not authenticated → `refreshAll` returns
  `{ statuses: {}, error: <message> }`; existing cached dots stay on screen.
- A single worktree's call failing (network, timeout) leaves that worktree's
  previous cached status in place rather than blanking it.
- Each `gh` call has a 15 second timeout.

## UI

- Dot: 8px circle before the name in `WorktreeRow`, omitted when `none`.
  Colors — draft `#8b949e`, review `#d29922`, changesRequested `#f28b82`,
  approved `#3fb950`, merged `#a371f7`, closed `#6e7681`.
- Clicking the dot opens the PR URL in the default browser.
- Header button: a `↻` ghost button next to `+ Group` / `+ Repo`, spinning
  while a refresh is in flight, tooltip showing the last error when there is one.

## Testing

- `tests/shared/pr-status.test.ts` — the derivation table, all six states plus
  unknown input.
- `tests/main/pr-status.test.ts` — `fetchPrStatus` with a stubbed runner: happy
  path, no-PR stderr, malformed JSON, and `refreshAll` fan-out.
- `tests/main/pr-status-config.test.ts` — cache round-trip, corrupt file
  degrades to `{}`, pruning of vanished paths.
- No component-render test: this codebase has no DOM testing library, so the
  row keeps its logic in the shared pure function instead.
