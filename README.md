# Worktree Manager

A personal Electron desktop app for managing git worktrees, with an embedded
persistent terminal per worktree and an in-app diff / stage / commit surface.

Built to replace bouncing out to a GUI editor: see all your worktrees, switch
between them instantly (each keeps its own live terminal session), and view/stage/
commit changes without leaving the app.

## Features

- **Worktree launchpad** — sidebar listing every worktree across your tracked repos,
  each with a live change-count badge. Create and remove worktrees inline. New
  worktrees are created in a sibling convention: `<repoParent>/.worktrees/<repo>/<branch>`.
- **Embedded terminals** — one persistent shell per worktree (xterm.js + node-pty).
  Switching worktrees preserves each terminal's running processes and scrollback.
- **Diff panel** — side-by-side syntax-highlighted diffs, per-file staging, and a
  commit box. Staging uses `git apply --cached`, so it extends to hunk/line-level
  staging without changing the backend interface.
- **lazygit escape hatch** — one click drops lazygit into the selected worktree's
  terminal for full git power.

## Requirements

- Node.js 20+
- git
- (optional) `lazygit` on your PATH for the lazygit button

## Getting started

```bash
npm install
npm run dev      # launch in development
```

Then click **+ Repo** in the sidebar to pick a git repository. Its worktrees appear;
select one to get a terminal, or open the **Diff** tab to review and commit changes.

## Scripts

| command | purpose |
|---|---|
| `npm run dev` | run the app in development |
| `npm run build` | build main/preload/renderer bundles |
| `npm start` | preview a production build |
| `npm test` | run the Vitest suite |

## Architecture

Electron two-process split:

- **Main (Node.js)** — git operations (`simple-git`), persistent ptys (`node-pty`),
  and file watching (`chokidar`). See `src/main/`.
- **Renderer (React)** — sidebar, diff panel, terminal. See `src/renderer/`.
- **IPC** — a single typed contract in `src/shared/ipc-types.ts`, exposed to the
  renderer through a `contextBridge` preload.

Design and implementation notes live in `docs/superpowers/`.

## Scope

Personal tool — not packaged, signed, or distributed. Push/pull/branch management
stay in the embedded terminal or lazygit by design.
