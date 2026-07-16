# Worktree Keyboard Navigation

## Goal

Navigate between worktrees with `Cmd+Up` / `Cmd+Down` without leaving the keyboard.
Today, switching worktrees requires clicking a sidebar row (`Sidebar.tsx:129`), which
means leaving the terminal — the thing you were typing in — to reach for the mouse.

## Behavior

- `Cmd+Down` selects the next worktree; `Cmd+Up` selects the previous one.
- Movement walks the flat `worktrees` array, crossing repo group boundaries
  transparently. There is no separate "move between repos" gesture.
- Movement wraps: `Cmd+Down` from the last worktree selects the first, and `Cmd+Up`
  from the first selects the last.
- `Cmd+Left` / `Cmd+Right` are not bound.
- While any modal is open, both shortcuts do nothing.

Flat-array order matches visual top-to-bottom order: the sidebar groups rows by repo
(`Sidebar.tsx:93-98`), but that grouping preserves `repos` order, which is also the
order `refreshWorktreeList` (`store.ts:38-43`) uses to build the flat array. So
wrapping from the last worktree of the last repo lands on the first worktree of the
first repo, which reads correctly on screen.

## Architecture

The shortcut is delivered as an **Electron menu accelerator**, matching the existing
path for `Cmd+N` (`menu.ts:16`) and `Cmd+Shift+R` (`menu.ts:26`):

```
menu.ts accelerator → webContents.send → preload bridge → App.tsx useEffect → store.selectRelative
```

Electron consumes accelerators before the renderer, so xterm never sees these keys.
This matters because `TerminalView.tsx:95` focuses the terminal on every selection
change, meaning the terminal holds focus essentially all the time. A renderer-level
`keydown` listener would have required a guard in `attachCustomKeyEventHandler`
(`TerminalView.tsx:68-77`) and would break on Linux/Windows, where `Ctrl+Up` would be
swallowed and forwarded to the shell as a control code. **`TerminalView.tsx` requires
no changes.**

## Components

### 1. `src/shared/ipc-types.ts`

Add two channels to `IPC`: `menuSelectPrev`, `menuSelectNext`. Add matching
`onMenuSelectPrev` / `onMenuSelectNext` subscription methods to the `Api` interface.

### 2. `src/main/menu.ts`

Extend the existing `Worktree` submenu (line 13) with a separator and two items:

| Label | Accelerator | Sends |
|---|---|---|
| Previous Worktree | `CmdOrCtrl+Up` | `IPC.menuSelectPrev` |
| Next Worktree | `CmdOrCtrl+Down` | `IPC.menuSelectNext` |

Menu placement is deliberate: it makes the shortcut discoverable rather than hidden.

### 3. `src/preload/index.ts`

Two `on*` bridges alongside the existing `onMenuNewWorktree` / `onMenuResetTerminal`
(lines 35-44), following the same subscription shape.

### 4. `src/renderer/state/store.ts`

Add to `State`:

- `modalOpen: number` — count of currently-open modals, initialized to `0`.
- `pushModal: () => void` / `popModal: () => void` — increment/decrement.
- `selectRelative: (delta: 1 | -1) => void`.

`selectRelative` logic, in order:

1. If `modalOpen > 0`, return.
2. Let `n = worktrees.length`. If `n === 0`, return.
3. Find `i = worktrees.findIndex(w => w.path === selected)`.
4. If `i === -1` (nothing selected, or the selected path is no longer in the list —
   possible because `refreshWorktreeList` re-polls every 3s per `store.ts:28-32`),
   select `worktrees[0]` for `delta === 1` and `worktrees[n - 1]` for `delta === -1`.
5. Otherwise select `worktrees[(i + delta + n) % n]`.

It delegates to the existing `select` (`store.ts:55`), inheriting localStorage
persistence and terminal reattach.

**Why a count, not a boolean:** `Sidebar` renders up to three `ConfirmModal`s
(`Sidebar.tsx:158-196`) and `App` renders `NewWorktreeModal` (`App.tsx:92`). With a
boolean, one modal unmounting would clear the guard while another was still open.

### 5. Modal components

`ConfirmModal.tsx` and `NewWorktreeModal.tsx` each call `pushModal` on mount and
`popModal` on unmount via their own `useEffect` with an empty dep array.

Placing the effect inside the modal components — rather than at each call site — means
the guard is maintained by the modal itself, and future modals inherit it without
anyone having to remember. This replaces the alternative of lifting the scattered
`pending` / `pendingRepo` / `pickError` / `newRepo` flags into the store.

### 6. `src/renderer/App.tsx`

One `useEffect` subscribing both channels to `selectRelative(-1)` / `selectRelative(1)`,
mirroring the existing menu subscriptions at `App.tsx:35-48`.

## Testing

`selectRelative` is pure store manipulation and is unit-tested in vitest:

- moves forward and backward through a multi-worktree list
- wraps forward from the last worktree to the first
- wraps backward from the first worktree to the last
- no-ops on an empty list
- with no selection: `delta 1` selects the first, `delta -1` selects the last
- with a stale `selected` path not present in `worktrees`: same as no selection
- no-ops when `modalOpen > 0`
- a single worktree re-selects itself for both deltas

`pushModal` / `popModal`: nested modals keep the guard active until the last one closes.

The menu, IPC, and preload wiring is declarative and verified by running the app:
confirm both shortcuts switch worktrees while the terminal has focus, that they wrap,
and that they no-op while a confirm modal is open.

## Out of Scope

- `Cmd+Left` / `Cmd+Right` bindings.
- Repo-group-aware navigation (staying within a repo, jumping between repos).
- `Cmd+1..9` direct selection.
- Reordering or sorting worktrees.
