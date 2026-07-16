# Push Button

## Goal

Push a worktree's commits without leaving the app. Today the changes panel can stage
and commit (`DiffPanel.tsx:127-136`) but there is no way to push — you drop to the
terminal for the last step of the loop.

Show a Push button in the changes panel footer when the selected worktree has commits
that aren't on the remote, and surface git's own message when a push is rejected.

## What "pending" means

This app creates a worktree per branch, so the most common case is a branch that has
never been pushed and has no upstream. `git rev-list --count @{u}..HEAD` errors there —
there is no `@{u}`. So "pending" is defined in two cases:

| Case | Pending count | Push command |
|---|---|---|
| Branch has an upstream | `rev-list --count @{u}..HEAD` | `git push` |
| No upstream | `rev-list --count <trunk>..HEAD` | `git push -u origin <branch>` |
| Detached HEAD | always `0` (button hidden) | n/a |
| No upstream and no trunk | `0` (button hidden) | n/a |

Both counts are local — **no `git fetch`**, no network. The count can therefore be
stale if the remote has moved; that's acceptable, because the push itself reports the
truth (and a rejection is exactly the message we surface).

Detached HEAD is excluded rather than supported: pushing one requires naming a target
ref, which is a different feature.

## Components

### 1. `src/main/git/trunk.ts` (new — extraction + cache)

`refExists` and `resolveTrunk` currently live in `committed.ts:6-26`. Move them here;
`committed.ts` imports them.

Rationale: `push.ts` needs `resolveTrunk` for the no-upstream count. Two consumers, and
reaching into a module about committed-file diffs for trunk resolution would be the
wrong dependency. This is the only refactor in scope.

**Add a cache**, keyed by worktree path: `Map<string, string | undefined>`. Trunk
resolution costs ~15 ms (measured) because it runs `symbolic-ref` plus up to four
`rev-parse --verify` probes, and it currently re-runs on *every* `getCommittedFiles`
call — which means on every status change. Trunk does not move during a session.

Caching is a net win for existing code, not just this feature: `getCommittedFiles`
(`committed.ts:51`) resolves trunk on every status change today and gets ~15 ms faster.

Accepted staleness: if `origin/HEAD` is repointed mid-session, the cache is wrong until
restart. That is rare, and the failure is a wrong diff base rather than data loss.

### 2. `src/main/git/push.ts` (new)

```ts
export interface PushState { branch: string; hasUpstream: boolean; ahead: number }
export type PushOutcome = { ok: true } | { ok: false; message: string }

export function pushArgs(branch: string, hasUpstream: boolean): string[]
export function getPushState(worktreePath: string): Promise<PushState>
export function push(worktreePath: string): Promise<PushOutcome>
```

`pushArgs` is pure: `['push']` when tracking exists, else `['push', '-u', 'origin', branch]`.
The remote is hardcoded to `origin`, consistent with `committed.ts` (17, 22, 57).

`getPushState`:

1. `branch = rev-parse --abbrev-ref HEAD`. If `HEAD` (detached) → `{ branch: 'HEAD', hasUpstream: false, ahead: 0 }`.
2. `hasUpstream` = whether `rev-parse --abbrev-ref --symbolic-full-name @{u}` succeeds
   (predicate style, as `committed.ts:6-8`).
3. If `hasUpstream` → `ahead = rev-list --count @{u}..HEAD`.
4. Else → `trunk = resolveTrunk()`; if none → `ahead = 0`; else `ahead = rev-list --count <trunk>..HEAD`.
5. On any unexpected failure, return `ahead: 0` (best-effort, as `committed.ts:49-66`).

`push` runs `pushArgs` output via simple-git with a non-interactive environment:

```
GIT_TERMINAL_PROMPT=0
GIT_SSH_COMMAND='ssh -o BatchMode=yes'
```

Without these, `git push` blocks on a credential or SSH-passphrase prompt against a
terminal that doesn't exist, and the button spins forever. With them it fails fast with
a readable message.

**Why `PushOutcome` instead of throwing:** Electron wraps a thrown main-process error,
so the renderer receives `Error invoking remote method 'diff:push': Error: ...` with
git's text buried in framing. The entire point of this feature is showing git's
rejection message, so `push` catches and returns `stderr` (falling back to `message`)
verbatim. This intentionally diverges from the bare pass-through handlers in
`ipc.ts:61-67`.

### 3. `src/shared/ipc-types.ts`

- `PushOutcome` exported.
- `IPC.pendingCount: 'push:pending'`; `Api.getPendingCount(worktreePath: string): Promise<number>`.
- `IPC.push: 'diff:push'`; `Api.push(worktreePath: string): Promise<PushOutcome>`.

**`WorktreeStatus` is unchanged.** Neither `ahead` nor `hasUpstream` crosses on it. The
count is fetched on demand, for the selected worktree only, by its own call — see below.

`getPendingCount` returns a bare `number`, not `PushState`: the panel needs only the
count, and `push` re-derives `branch` / `hasUpstream` in the main process to choose its
arguments. `PushState` stays internal to `push.ts`.

### 4. Why the count is NOT part of `getStatus`

The obvious design is folding `getPushState` into `getStatus` so the count rides the
existing `refreshStatus` plumbing and updates for free. **Measurements ruled this out.**

Measured on this repo:

| call | cost |
|---|---|
| `getStatus` today | 68.5 ms |
| `getPushState`, upstream exists | +18.4 ms |
| `getPushState`, no upstream (the common case here) | +40.3 ms |
| └ of which `resolveTrunk` (now cached) | 15.1 ms |

`git status --porcelain -uall` already dominates at 68 ms because it stat-walks the
working tree; the added `rev-parse`/`rev-list` calls are ~6 ms each. So the increase is
+27% with tracking, +59% without.

That increase is not paid once. `watchers.watch(p, …)` is registered in `termStart`
(`ipc.ts:85`), so **every worktree selected during a session stays watched for the rest
of it**, and is only released when the worktree is removed (`ipc.ts:58`). Any file
change in any watched worktree debounces 300 ms (`watcher.ts`) and fires
`statusChanged` → `refreshStatus` for that worktree — regardless of which one is
selected. Several worktrees with builds or agents writing files therefore drive multiple
`getStatus` calls per second, continuously.

This is a known sore spot. The comment at the top of `watcher.ts` records that watching
`node_modules` "stalls the main event loop — starving the terminal IPC and causing
multi-second typing lag". Inflating every `getStatus` by up to 59% spends the headroom
that fix bought, in the same place, for a number only the selected worktree displays.

So the count is fetched per-worktree, on demand. Background and unvisited worktrees pay
nothing. The cost lands only on the worktree whose panel is on screen.

**Consequence:** a future sidebar badge no longer gets the data for free — it would need
its own fan-out and would reintroduce exactly this cost. That is accepted; the badge is
out of scope, and the trade favours not regressing terminal latency.

### 5. `src/main/ipc.ts` + `src/preload/index.ts`

Two handlers and two bridges, following the existing shapes:

```
ipcMain.handle(IPC.pendingCount, (_e, p) => getPushState(p).then(s => s.ahead))
ipcMain.handle(IPC.push, (_e, p) => push(p))
```

### 6. `src/renderer/components/DiffPanel.tsx`

Local state: `pending: number` (default `0`), `pushing: boolean`, `pushError?: string`.

**Fetching the count.** A `useEffect` keyed on `[selected, status]` calls
`getPendingCount(selected)` and stores the result. Keying on `status` is what keeps it
current: `status` is a new object on every `refreshStatus`, so the count re-fetches
after a commit, after a watcher event, and on the 3s poll for the selected worktree —
the same cadence it would have had inside `getStatus`, without the fan-out cost.

The effect must guard against races. `selected` can change while a fetch is in flight,
and a stale response would show the previous worktree's count against the new one. Use
a `cancelled` flag in the cleanup, as is standard:

```ts
useEffect(() => {
  if (!selected) return
  let cancelled = false
  window.api.getPendingCount(selected).then(n => { if (!cancelled) setPending(n) })
  return () => { cancelled = true }
}, [selected, status])
```

Also reset `pushError` when `selected` changes — an error from one worktree must not
linger over another.

**The button**, in the footer (`:127`, already `flexDirection: 'column', gap: 6`), below
Commit, rendered only when `pending > 0`:

- Label: `Push {pending} commit{s}`; `Pushing…` while in flight; disabled while pushing.
- Styling: inline, matching the panel; accent `#0e639c`, disabled `#3a3a3a`.
- On failure: git's message below the button in `#f28b82` with `whiteSpace: 'pre-wrap'`,
  `maxHeight` + `overflow: 'auto'` (rejection messages are long and multi-line). Same
  red `ConfirmModal.tsx:25` uses.
- Error state clears on the next press.
- On success: clear `pushError` and call `refreshStatus(selected)`, which produces a new
  `status` object → the effect re-runs → `pending` → 0 → button unmounts.

Unlike `doCommit` (`DiffPanel.tsx:35-43`), which has no `catch`, this path must handle
failure: a silently failed push looks identical to a successful one, and the user would
believe their work was on the remote when it wasn't.

## Testing

Real git via `makeTmpRepo` (`tests/helpers/tmpRepo.ts`) plus a bare remote, not mocks.

`getPushState`:
- upstream exists, N local commits → `ahead: N`, `hasUpstream: true`
- upstream exists, nothing new → `ahead: 0`
- no upstream, branch off trunk with N commits → `ahead: N`, `hasUpstream: false`
- detached HEAD → `ahead: 0`
- no upstream and no trunk → `ahead: 0`

`pushArgs` (pure):
- with upstream → `['push']`
- without → `['push', '-u', 'origin', 'feat-x']`

`push`:
- first push with no upstream establishes tracking and lands the commit on the bare remote
- non-fast-forward rejection → `{ ok: false }` with git's message preserved (assert it
  mentions the rejection rather than matching exact text, which varies by git version)

`resolveTrunk` cache:
- resolving twice for the same worktree path hits the cache the second time (assert by
  observing that a `resolveTrunk` call after deleting the trunk ref still returns the
  cached value — proving no re-resolution occurred)

**Not covered:** the DiffPanel footer, including the count-fetch effect and its race
guard. No component test setup exists in this repo, and adding one for a single button
isn't warranted. Verified by running the app: commit, confirm the button appears with
the right count, push, confirm it disappears; switch worktrees rapidly and confirm the
count doesn't bleed across; then push a rejected branch and confirm the message renders.

## Out of Scope

- Force push, and any `--force-with-lease` affordance.
- Pull / fetch / sync.
- Sidebar per-worktree badges. Deferred, and now genuinely more expensive: the count is
  no longer carried on `WorktreeStatus`, so a badge would need its own per-worktree
  fan-out — reintroducing the cost that section 4 exists to avoid.
- Pushing a detached HEAD.
- Remotes other than `origin`.
- Choosing or editing the upstream branch name (always `origin/<branch>`).
