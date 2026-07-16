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

### 1. `src/main/git/trunk.ts` (new — extraction)

`refExists` and `resolveTrunk` currently live in `committed.ts:6-26`. Move them here
verbatim; `committed.ts` imports them.

Rationale: `push.ts` needs `resolveTrunk` for the no-upstream count. Two consumers, and
reaching into a module about committed-file diffs for trunk resolution would be the
wrong dependency. This is the only refactor in scope.

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

- `WorktreeStatus` gains `ahead: number`.
- `PushOutcome` exported.

`hasUpstream` deliberately does **not** cross the IPC boundary. The button's visibility
keys off `ahead > 0`, and `push` re-derives upstream state in the main process to pick
its arguments, so exposing it to the renderer would add a field with no consumer.
- `IPC.push: 'diff:push'`; `Api.push(worktreePath: string): Promise<PushOutcome>`.

### 4. `src/main/git/status.ts`

`getStatus` calls `getPushState` and includes its `ahead` in the result.

This rides the existing refresh plumbing: `refreshStatus` (`store.ts:69-72`) already
re-fetches on commit, on watcher events, and every 3s for the selected worktree, so the
button appears after a commit and disappears after a push with no extra wiring.

**Cost:** `refreshWorktrees` (`store.ts:57-60`) fans out `getStatus` per worktree, so
every worktree pays ~2 extra local git calls per refresh. `rev-list --count` is local
and single-digit milliseconds; at this app's scale that's noise. It also means a future
sidebar badge needs no new plumbing.

### 5. `src/main/ipc.ts` + `src/preload/index.ts`

One `ipcMain.handle(IPC.push, (_e, p) => push(p))` and one `push: (p) => ipcRenderer.invoke(IPC.push, p)`,
following the existing shapes.

### 6. `src/renderer/components/DiffPanel.tsx`

In the footer (`:127`, already `flexDirection: 'column', gap: 6`), below Commit,
rendered only when `status.ahead > 0`:

- Label: `Push {ahead} commit{s}`; `Pushing…` while in flight; disabled while pushing.
- Styling: inline, matching the panel; accent `#0e639c`, disabled `#3a3a3a`.
- On failure: git's message below the button in `#f28b82` with `whiteSpace: 'pre-wrap'`,
  `maxHeight` + `overflow: 'auto'` (rejection messages are long and multi-line). Same
  red `ConfirmModal.tsx:25` uses.
- Error state clears on the next press.
- On success: `refreshStatus(selected)` → `ahead` → 0 → button unmounts.

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

**Not covered:** the DiffPanel footer. No component test setup exists in this repo, and
adding one for a single button isn't warranted. Verified by running the app: commit,
confirm the button appears with the right count, push, confirm it disappears; then push
a rejected branch and confirm the message renders.

## Out of Scope

- Force push, and any `--force-with-lease` affordance.
- Pull / fetch / sync.
- Sidebar per-worktree badges (deferred; the data will already be on `WorktreeStatus`).
- Pushing a detached HEAD.
- Remotes other than `origin`.
- Choosing or editing the upstream branch name (always `origin/<branch>`).
