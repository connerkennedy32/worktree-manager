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
- Claude Code CLI (`claude`) — required for the sidebar's live agent-status
  highlighting; the rest of the app works without it
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

## Agent status monitoring

Each sidebar row highlights (pulsing yellow while working, amber while
waiting on a permission prompt, red tint on failure, green until you select
it when done) based on **Claude Code hooks**, not process polling. This is
self-installing — no manual setup is required on a new machine, but it's
worth knowing what it does since it touches global config:

- On every app start, `installAgentHooks()` (`src/main/agent-hooks/install.ts`)
  writes a script to `<userData>/notify-hook.sh` and merges hook entries for
  `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`,
  `Stop`, `StopFailure`, and `SessionEnd` into your **global**
  `~/.claude/settings.json`. It preserves everything else already in that
  file and backs it up once to `settings.json.wtm-backup` before ever
  touching it.
- The script is a no-op for any `claude` invocation not launched from this
  app's own embedded terminals — it exits immediately unless the
  `WTM_TERMINAL_ID` / `WTM_HOOK_SOCKET` env vars (injected only into this
  app's ptys) are present, so it's safe to have installed even if you also
  run `claude` elsewhere on the same machine.
- These events flow over a local unix socket to a small background daemon
  (`src/main/pty-daemon/`), which is what the sidebar actually reads from.

If the row highlighting ever stops updating after a fix or update, it's
almost always one of these:

- **A `claude` session already running when the app started** won't have the
  hooks yet — restart that terminal session.
- **A stale background daemon** from a previous run/build can keep serving
  old behavior, since it's deliberately long-lived so terminals survive an
  app restart. Find and kill it with `ps aux | grep pty-daemon.js`, then
  reopen a terminal in the app to respawn a fresh one.
- Check `~/.claude/settings.json` directly for a `notify-hook.sh` entry per
  event above if you want to confirm the install took.

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
