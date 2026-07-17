# Agent Status Indicator — Handoff (incomplete)

**Branch:** `agent-status-indicator` (off `main`). Not merged. Not GUI-verified.

Executing `docs/superpowers/plans/2026-07-16-agent-status-indicator.md` via
subagent-driven development (fresh implementer + reviewer per task). Paused
mid-Task-7. Resume with the same plan.

## What the feature does

Puts a status dot on each left-pane worktree row showing what the agent in that
terminal is doing: green pulse = working, amber pulse = waiting on a permission
prompt, red = failed, grey = finished-but-unseen (clears when you visit the
tab). Driven by **Claude Code hooks** (installed into `~/.claude/settings.json`),
not by guessing from terminal output. See the spec:
`docs/superpowers/specs/2026-07-16-agent-status-indicator-design.md`.

## Status by task

| Task | What | State |
|---|---|---|
| 1 | `src/shared/agent-status.ts` — event→status + dot derivation (pure) | ✅ done, reviewed clean (commit 0adb364) |
| 2 | `src/main/pty-daemon/agentProcess.ts` — `ps` parse + descendant walk (pure) | ✅ done, reviewed clean (24d2690) |
| 3 | `src/main/agent-hooks/merge.ts` — settings.json merge (pure) | ✅ done, reviewed after 1 fix (13f697b, 3380d13) |
| 4 | `src/main/agent-hooks/install.ts` — write script + settings | ✅ done, reviewed clean (1e1014f) |
| 5 | `sessionStore.ts` — session id + env injection | ✅ done, reviewed clean (c0cddd3) |
| 6 | `src/main/pty-daemon/agentTracker.ts` — hook handling + clear-only backstop | ✅ done, reviewed after 1 fix (3cf74eb, f685aab) |
| 7 | `src/main/pty-daemon/hookServer.ts` — HTTP server on a unix socket | ⚠️ **WIP, tests FAILING — see below** |
| 8 | Wire hook server + tracker into `daemon.ts`, add protocol variant | ❌ not started |
| 9 | Forward status daemon→renderer (client.ts, ipc.ts, index.ts, preload, ipc-types) | ❌ not started |
| 10 | Store state + sidebar dot (store.ts, seen.ts, Sidebar.tsx, css) | ❌ not started |
| 11 | End-to-end verification in the real app | ❌ not started |

All committed work: `git log --oneline main..agent-status-indicator`. Full test
suite was green (171/171) through Task 6.

## Task 7 is broken — start here on resume

`src/main/pty-daemon/hookServer.ts` and `tests/pty-daemon/hookServer.test.ts`
are committed as WIP. **All 4 tests fail:** curl connects to the unix socket but
gets no HTTP response — `curl: (28) Operation timed out after 2001ms with 0
bytes received`. The connection is accepted (socket file exists) but the server
never replies.

This was NOT reviewed and NOT fixed — I ran the test, saw it fail, and stopped.
Likely suspects to check when resuming:
- Does `http.Server` bound to a unix socket path actually emit `'listening'`
  and serve requests the way the test's `serve()` helper assumes? (A manual
  probe earlier in the session — Node http server on a socket + `curl
  --unix-socket` — *did* work, so compare that working probe against this code.)
- The handler responds on `req.on('end')`; confirm `end` fires and `res.end()`
  is actually reached (add a log, or test the server with a direct Node client
  instead of curl to isolate whether it's the server or the curl invocation).
- Possible test-harness issue: `execFileSync('curl', [...])` passing the
  `Content-Type` header/body as separate argv items — verify the args array is
  well-formed.

Decide whether the bug is in the server or the test, fix with TDD, then resume
the normal per-task review loop.

## How to resume

1. `git checkout agent-status-indicator`
2. Re-read the plan and this file. The SDD ledger with per-task detail and all
   deferred Minor findings is at `.superpowers/sdd/progress.md` (git-ignored
   scratch — may be gone; the commit list is the durable record).
3. Fix Task 7 first, then Tasks 8–11 in order.
4. Nothing has touched the renderer yet, and **the hook install (Task 4) is
   wired in Task 9** — so running the app right now does NOT modify your real
   `~/.claude/settings.json`. That only starts happening once Task 9 lands
   `installAgentHooks()` in `src/main/index.ts`.

## Deferred Minor findings (for the final whole-branch review)

- Task 2: `hasAgentDescendant` uses `queue.shift()` → O(n²); harmless on tiny
  process trees.
- Task 4: temp filename `${settings}.wtm-tmp` not unique per-call (concurrent
  installs could race; called once at startup). `WTM_TERMINAL_ID` interpolated
  into the hook JSON unescaped — safe today (internal UUID), latent if a label
  ever flows in.
