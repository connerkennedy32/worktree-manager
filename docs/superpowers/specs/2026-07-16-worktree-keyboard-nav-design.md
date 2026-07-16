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

The shortcut is intercepted in the main process via **`before-input-event`**, which
fires ahead of the renderer and independently of focus:

```
shortcuts.ts before-input-event → webContents.send → preload bridge → App.tsx useEffect → store.selectRelative
```

`TerminalView.tsx:95` focuses the terminal on every selection change, so the terminal
holds focus essentially all the time. Any mechanism that lets the key reach the
renderer first will lose it to xterm.

### Why not a menu accelerator

The first implementation registered `CmdOrCtrl+Up` / `CmdOrCtrl+Down` as accelerators
on the menu items, on the assumption that Electron consumes accelerators before the
renderer. **That assumption is false on macOS.** Chromium offers the key to the
renderer first, and xterm calls `preventDefault()` on `Cmd+Arrow` while focused, which
suppresses the accelerator entirely. The shortcut worked only when the sidebar happened
to hold focus.

Instrumenting both boundaries made this unambiguous: over ~40 presses,
`before-input-event` fired every time, while the menu `click` handler fired twice —
exactly the presses where the terminal was not focused.

`before-input-event` runs in the main process before the key is dispatched to the page,
so it is unaffected by xterm, by focus, and by platform key-handling differences.
`attachShortcuts` calls `event.preventDefault()`, so the terminal never receives the
key. **`TerminalView.tsx` requires no changes** — this remains true, but because the
key is intercepted upstream, not because accelerators bypass the renderer.

The menu items are retained with `registerAccelerator: false`: the accelerator is
displayed for discoverability and the items still work when clicked, but it is not
registered as a key handler. Leaving it registered would double-fire — both the
accelerator and `before-input-event` fire for the same press when the sidebar has
focus, stepping two worktrees per keystroke.

## Components

### 1. `src/shared/ipc-types.ts`

Add two channels to `IPC`: `menuSelectPrev`, `menuSelectNext`. Add matching
`onMenuSelectPrev` / `onMenuSelectNext` subscription methods to the `Api` interface.

### 2. `src/main/menu.ts`

Extend the existing `Worktree` submenu (line 13) with a separator and two items:

| Label | Accelerator (display only) | Sends |
|---|---|---|
| Previous Worktree | `CmdOrCtrl+Up` | `IPC.menuSelectPrev` |
| Next Worktree | `CmdOrCtrl+Down` | `IPC.menuSelectNext` |

Both carry `registerAccelerator: false`. Menu placement is deliberate: it makes the
shortcut discoverable rather than hidden.

### 3. `src/main/shortcuts.ts` (new)

`shortcutFor(input, isMac): 'prev' | 'next' | null` — a pure decision function over the
`before-input-event` input, kept free of `electron` imports so it is unit-testable in
the node test environment.

It requires the modifier **exclusively**: Cmd and not Ctrl on macOS, Ctrl and not Cmd
elsewhere, and rejects any press carrying Alt or Shift. This keeps bare arrows (shell
history, cursor movement) and `Ctrl+Arrow` (a control sequence on macOS) flowing to the
terminal, and leaves `Cmd+Shift+Arrow` free for future bindings. It also ignores
`keyUp`, so one press steps exactly one worktree.

`attachShortcuts(win, isMac)` registers the `before-input-event` listener, calls
`event.preventDefault()` on a match, and sends the corresponding IPC channel. Wired in
`index.ts` next to `buildAppMenu(win)`.

### 4. `src/preload/index.ts`

Two `on*` bridges alongside the existing `onMenuNewWorktree` / `onMenuResetTerminal`
(lines 35-44), following the same subscription shape.

### 5. `src/renderer/state/store.ts`

Add to `State`:

- `modalOpen: number` — count of currently-open modals, initialized to `0`.
- `pushModal: () => void` / `popModal: () => void` — increment/decrement.
- `selectRelative: (delta: 1 | -1) => void`.

`selectRelative` logic, in order:

1. If `modalOpen > 0` or `openDiff` is set, return.
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

**Why `openDiff` is read directly rather than via `pushModal`:** the diff modal's open
state already lives in the store as `openDiff`. Having `DiffModal` also push onto the
counter would duplicate that truth and let the two drift apart.

### 6. Modal components

`ConfirmModal.tsx` and `NewWorktreeModal.tsx` each call `pushModal` on mount and
`popModal` on unmount via their own `useEffect` with an empty dep array.

Placing the effect inside the modal components — rather than at each call site — means
the guard is maintained by the modal itself, and future modals inherit it without
anyone having to remember. This replaces the alternative of lifting the scattered
`pending` / `pendingRepo` / `pickError` / `newRepo` flags into the store.

### 7. `src/renderer/App.tsx`

One `useEffect` subscribing both channels to `selectRelative(-1)` / `selectRelative(1)`,
mirroring the existing menu subscriptions at `App.tsx:35-48`.

## Testing

`shortcutFor` is unit-tested in vitest (`tests/main/shortcuts.test.ts`), covering both
platforms: Cmd+Arrow maps on macOS and Ctrl+Arrow off it; bare arrows, `Ctrl+Arrow` on
macOS, `Cmd+Arrow` off macOS, non-arrow keys, `keyUp`, and Alt/Shift combinations all
return null.

`selectRelative` is unit-tested in vitest (`tests/renderer/store-select-relative.test.ts`).
Note that it is *not* purely in-memory: `select` writes to `localStorage`, which does not
exist in the `node` test environment, so the test installs a small in-memory
`localStorage` stub before importing the store. Cases covered:

- moves forward and backward through a multi-worktree list
- wraps forward from the last worktree to the first
- wraps backward from the first worktree to the last
- no-ops on an empty list
- with no selection: `delta 1` selects the first, `delta -1` selects the last
- with a stale `selected` path not present in `worktrees`: same as no selection
- no-ops when `modalOpen > 0`
- no-ops when `openDiff` is set
- a single worktree re-selects itself for both deltas

`pushModal` / `popModal`: nested modals keep the guard active until the last one closes.

The `before-input-event`, IPC, and preload wiring cannot be covered by these tests —
it depends on real key delivery through Electron. It is verified by running the app and
confirming both shortcuts switch worktrees **while the terminal has focus** (the case
the original accelerator design failed), that they wrap, and that they no-op while a
modal is open.

## Out of Scope

- `Cmd+Left` / `Cmd+Right` bindings.
- Repo-group-aware navigation (staying within a repo, jumping between repos).
- `Cmd+1..9` direct selection.
- Reordering or sorting worktrees.
