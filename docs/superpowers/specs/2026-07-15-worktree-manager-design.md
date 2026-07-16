# Worktree Manager — Design Spec

**Date:** 2026-07-15
**Status:** Approved, ready for implementation planning

## Problem

Working across multiple git worktrees (for parallel manual work and/or AI coding
agents) is painful today. In a terminal/tmux workflow it is hard to:

- see all worktrees at once and navigate between them easily,
- see file changes clearly, and
- stage and commit changes without leaving for a GUI editor (Cursor).

The result is constant context-switching out to Cursor just to view diffs and commit.

## Goal

A **personal desktop application** (never distributed/released) that surrounds an
embedded terminal with a worktree launchpad and a rich diff/commit surface — the
Conductor/Superset shape, deliberately simplified. The user stays "in the terminal"
because the terminal is embedded *inside* the app, one persistent session per worktree.

### In scope
- View all worktrees, switch between them instantly.
- Embedded terminal per worktree (persistent, survives switching).
- View diffs clearly (side-by-side, syntax-highlighted) — **goal A**.
- Stage at hunk/line level and commit in-app — **goal B**.

### Out of scope
- Distribution: no packaging, code-signing, notarization, or auto-update. Personal, run-locally only.
- Full git operations (push/pull/branch management). These stay in the embedded
  terminal or lazygit.

## Chosen Stack

- **Electron** app shell (batteries-included, VS Code / Conductor stack; runtime
  weight is irrelevant for a personal tool).
- **React** renderer for UI.
- **xterm.js** terminal renderer + **node-pty** pseudo-terminal backend (the
  standard, well-documented embedded-terminal recipe).
- **simple-git** for structured git commands; raw `git ... --porcelain` where exact
  parsing is needed.
- **react-diff-view** for diff rendering (gives per-hunk/per-line structure, which
  enables staging); **refractor/Prism** for syntax highlighting.
- **chokidar** for per-worktree file watching (live change badges).

## Architecture

Standard Electron two-process split:

- **Main process (Node.js)** — privileged backend: spawns ptys, runs git, watches
  worktree directories.
- **Renderer process (React)** — UI only: worktree sidebar, diff panel, xterm.js surface.
- **IPC bridge** — a small typed message set: `listWorktrees`, `createWorktree`,
  `removeWorktree`, `getDiff`, `stage`, `unstage`, `commit`, `terminalInput`,
  `terminalOutput`, `terminalResize`.

Principle: **React draws it, Node does it, IPC connects them.**

### Layout

```
┌─ App ──────────────────────────────────────────────────────┐
│ WORKTREES        │  DIFF: fix-parser                        │
│ ─────────        │  side-by-side, syntax-highlighted        │
│ ▸ main           │  [stage] [commit]                        │
│   feat-auth   ●2 │                                          │
│ ▸ fix-parser  ●5 │  ────────────────────────────────────   │
│   spike-redis ●1 │  TERMINAL (fix-parser)                   │
│ + New worktree   │  $ npm test                              │
└──────────────────┴──────────────────────────────────────────┘
```

## Components

### 1. Worktree management
- Point the app at a repo (or a few). Enumerate worktrees via `simple-git` /
  `git worktree list --porcelain`.
- Each row: branch, path, and a **live change badge** (count from
  `git status --porcelain`, kept fresh by a `chokidar` watcher).
- **New worktree:** form takes a branch (new or existing); runs
  `git worktree add`. New worktrees live in a predictable sibling directory
  convention (e.g. `~/Code/myrepo` → `~/Code/.worktrees/myrepo/<branch>`).
- **Delete worktree:** `git worktree remove`, guarded with a warning if the
  worktree has uncommitted changes (warn, never silently discard).
- **Switch:** selecting a row drives both the diff panel and the terminal to that
  worktree.

### 2. Embedded terminals (persistent per worktree)
- On first open of a worktree, main spawns a **node-pty** running `$SHELL` with
  `cwd` = the worktree path. The pty stays alive in the background for the
  worktree's lifetime.
- Renderer holds an **xterm.js** instance: pty output → IPC → xterm; keystrokes →
  IPC → pty.
- Switching worktrees reveals that worktree's own terminal; background processes
  (e.g. a running test watcher) keep running. "N terminals, one per task."
- Resize via xterm `fit` addon, forwarding size changes to the pty.
- Does **not** embed tmux — the app provides persistent-session-per-worktree
  itself. The user can still run tmux inside a terminal if desired.

### 3. Diff / staging / commit panel
Designed to start at goal A and grow into goal B behind one interface.

- **Viewing (Phase A):** file list from `git status --porcelain`; click a file →
  side-by-side syntax-highlighted diff via `react-diff-view`; unified/side-by-side
  toggle.
- **Staging + commit (Phase B):** because `react-diff-view` exposes hunk/line
  structure, staging = select hunks/lines → build a patch → apply with
  `git apply --cached` (the mechanism behind `git add -p`). Commit box: staged
  summary + message → `git commit`.
- **Clean seam:** the renderer talks to a `DiffService` interface
  (`getDiff`, `stage`, `unstage`, `commit`). Phase A implements the read methods;
  Phase B fills in staging behind the same interface with no UI reshape.
- **Escape hatch:** an "Open in lazygit" button launches lazygit in the worktree's
  embedded terminal — full git power from day one, before native staging exists.

## Error Handling
- Destructive actions (worktree removal with uncommitted changes) warn and require
  confirmation; never silently discard work.
- Git command failures surface as readable messages in the UI, not silent no-ops.
- pty crashes are recoverable: a dead terminal can be respawned for its worktree.

## Testing
- **Git/worktree logic** — highest value; pure Node functions tested against
  throwaway temp git repos created per test. No git mocking.
- **DiffService patch-building** — unit-tested against known diff fixtures; assert
  generated patches apply correctly (the trickiest Phase B logic).
- **IPC contract** — typed message schema tested so main/renderer stay in sync.
- **UI** — light React Testing Library component tests for sidebar and diff list.
  No full end-to-end Electron automation (YAGNI for a personal tool).

## Build Phasing
Each phase is independently usable.

- **Phase 0 — Skeleton:** Electron + React + IPC bridge; empty three-panel window.
- **Phase 1 — Worktree launchpad:** sidebar with live change badges; create/delete/switch. Already useful.
- **Phase 2 — Embedded terminals:** persistent node-pty per worktree + xterm.js;
  plus "Open in lazygit" → full diff/staging via lazygit while native diff is built.
- **Phase 3 — Diff viewing (goal A):** react-diff-view side-by-side, file list,
  syntax highlighting.
- **Phase 4 — Staging + commit (goal B):** hunk/line staging via `git apply --cached`, commit box.

Useful tool exists by end of Phase 2; each later phase is pure upside.
