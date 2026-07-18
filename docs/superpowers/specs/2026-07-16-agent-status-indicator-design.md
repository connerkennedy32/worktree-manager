# Agent Status Indicator

## Problem

The sidebar shows what git knows about each worktree — branch, main-vs-branch icon, uncommitted change count — but nothing about what is happening *inside* the worktree's terminal. When an agent runs in several worktrees at once, there is no way to tell from the left pane which one is churning, which one is blocked asking permission, and which one has finished. You have to click through tabs to find out.

## Goal

Show, per sidebar row, what the agent in that worktree is doing — and make any visible dot mean "this needs me".

## Approach: ask Claude, don't guess

An earlier revision of this spec inferred status from the outside: walk the process tree for a `claude` descendant, and treat "PTY emitted output in the last 750ms" as *working*, on the theory that the thinking spinner repaints continuously.

That is abandoned. Claude Code has a **hooks** system: it runs a command of our choosing on lifecycle events and pipes it a JSON payload. It will tell us exactly what it is doing. No thresholds, no spinner heuristics, no tuning.

This mirrors how Superset (`github.com/superset-sh/superset`) solves the same problem in the same shape of app. Notably, their terminal-title scanner *strips* spinner glyphs as noise — the exact signal the old design depended on.

Verified against the hooks reference (https://code.claude.com/docs/en/hooks.md):

- `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`, `StopFailure`, `SessionStart`, `SessionEnd` are all real events.
- Every payload carries `hook_event_name` and `session_id` on stdin.
- **Hook commands inherit environment variables from the shell that launched `claude`.** This is the linchpin: it lets a hook identify which terminal it came from, so a manually-typed `claude` reports in without the app launching it.

### Why an env var and not `cwd`

The payload includes `cwd`, which is tempting since our sessions are keyed by worktree path. But `cwd` follows the user — one `cd` and the mapping breaks. An injected identifier is stable for the life of the PTY.

The identifier is an **opaque id, not the path**. The hook script is bash assembling JSON; a path is arbitrary text that would need escaping (quotes, backslashes) to be embedded safely. An opaque id sidesteps escaping entirely. The daemon maps id → path.

## States

The daemon tracks a raw status per worktree, derived from the last event:

| Event | Raw status | Meaning |
|---|---|---|
| `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` | `working` | agent is churning |
| `PermissionRequest` | `permission` | blocked asking to run something |
| `Stop` | `done` | turn finished |
| `StopFailure` | `failed` | turn died on an API error |
| `SessionEnd` | `none` | agent gone |
| `SessionStart` | *(ignored)* | agent booted but is idle awaiting input — not a working state, and nothing to act on |

`PostToolUse` maps to `working` so a long multi-tool turn keeps reporting rather than decaying. `PostToolUseFailure` also maps to `working`: a failed tool call does not end the turn.

### Display, with seen-gating

The renderer derives what to draw from the raw status plus a per-worktree `seenAt` (updated when you select that worktree, persisted in `localStorage`):

| Raw | Dot |
|---|---|
| `working` | green, pulsing |
| `permission` | amber, pulsing |
| `failed` | red, static |
| `done` **and** `lastEventAt > seenAt` | grey, static |
| `done` **and** already seen | *nothing* |
| `none` | *nothing* |

Only `done` is seen-gated. `permission` and `failed` are live states that must persist until actually resolved — visiting the tab does not un-block a permission prompt.

The payoff: any visible dot means unhandled. Finishing a turn lights the row; visiting it clears the row.

## Architecture

### 1. Hook installation — `src/main/agent-hooks/install.ts` (new, main process)

On app start:

1. Write the hook script to `configDir()/notify-hook.sh`, `chmod 0755`.
2. Merge our hook entries into `~/.claude/settings.json`.

Merging is the risky part — this is the user's global config and must never be clobbered:

- Read and parse; **on any parse error, abort and log**. Never overwrite a file we could not read.
- Back up once to `settings.json.wtm-backup` if no backup exists.
- Identify our entries by their exact script path (`command === scriptPath`). Collapse any duplicate of ours, then append one current entry. Preserve every other hook untouched. (We deliberately do not attempt cross-path cleanup of hooks from an old install location: the script always lives at a stable `configDir()/notify-hook.sh`, and loose matching risks deleting a user's own hook in this global file.)
- Write atomically: temp file in the same directory, then `rename`.

**Scope caveat:** `~/.claude/settings.json` applies to *every* project, so this script runs on every `claude` invocation anywhere on the machine. It must therefore be near-free and silent when it is not ours — hence the env-var guard as the very first line.

### 2. Env injection — `sessionStore.ts`

`PtyManager.start` generates an opaque id per session and injects:

```
WTM_TERMINAL_ID=<uuid>
WTM_HOOK_SOCKET=<configDir()/agent-hook.sock>
```

`Session` gains `id`. The daemon holds an `id → worktreePath` map.

### 3. The hook script

```bash
#!/bin/bash
# wtm-agent-hook — reports Claude Code lifecycle events to Worktree Manager.
# Installed in the user's global settings, so it runs for every `claude`
# everywhere. Exit immediately unless launched from one of our terminals.
[ -z "$WTM_TERMINAL_ID" ] && exit 0
[ -S "$WTM_HOOK_SOCKET" ] || exit 0

EVENT=$(cat | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
# Never guess an event on a parse failure: a wrong "Stop" would falsely clear
# a working indicator. Dropping the event is always safer.
[ -z "$EVENT" ] && exit 0

curl -sS --unix-socket "$WTM_HOOK_SOCKET" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"id\":\"$WTM_TERMINAL_ID\",\"event\":\"$EVENT\"}" \
  --connect-timeout 1 --max-time 2 \
  http://localhost/hook >/dev/null 2>&1
exit 0
```

Both `WTM_TERMINAL_ID` and `EVENT` are constrained values (a uuid we generated; an event name matched by regex), so embedding them in JSON needs no escaping.

The script always `exit 0` — a hook that fails must never disturb the user's Claude session.

### 4. Transport — a second unix socket

The existing daemon socket speaks length-prefixed JSON frames, not HTTP, so the hook endpoint gets its own socket at `configDir()/agent-hook.sock` running `http.createServer`.

Verified working: macOS ships curl 8.7.1 with `--unix-socket`, and a Node HTTP server bound to a socket path receives the POST.

A unix socket rather than a localhost TCP port: nothing is exposed on the network, no port to allocate or collide, and filesystem permissions gate access.

### 5. The `ps` backstop

Hooks are events, so a *missing* event is invisible. If Claude is `SIGKILL`ed mid-turn, `SessionEnd` never fires and the row would sit at `working` forever. Superset has exactly this bug: their binding is only cleared on terminal exit.

So a reduced version of the old process check survives, in a purely corrective role: every 2s, if a worktree's raw status is not `none` and its PTY has **no `claude` descendant**, force it to `none`.

It can only *clear* state, never create it. Hooks remain the sole source of positive status.

Two consequences worth stating:

- **It only polls when something is active.** If every worktree is `none`, no `ps` runs at all — the idle machine does nothing.
- The process-matching rules are unchanged from the old design and still apply, because `ps` output is still `ps` output:
  - Parse pid, ppid, and **rest-of-line** — `comm` can contain spaces (`claude bg-pty-host`).
  - Match `basename(firstToken(comm)) === 'claude'` — `comm` can be an absolute path.
  - Do **not** match the versioned form (`.../versions/2.1.201`). Those are Claude's own daemon processes, reparented to launchd (`ppid 1`), outside any PTY subtree.

### 6. Renderer

`store.ts` gains `agentStatuses: Record<string, AgentReport>` where `AgentReport = { status: RawStatus; at: number }`, plus `seenAt: Record<string, number>` persisted to `localStorage`. `select()` stamps `seenAt[path] = Date.now()`.

Push-driven from the daemon; it does **not** join the 3s poll loop. On init the renderer fetches the current map once, since `registerIpc` connects the daemon client only once (`ipc.ts:37`) and a window reload would otherwise miss the connect-time snapshot.

`Sidebar.tsx` renders `<AgentDot/>` at the leading edge beside `MainDotIcon`/`BranchIcon`, clear of the right-side badge cluster. The dot always occupies a fixed-width slot even when empty, so a starting agent never shifts row labels sideways.

Pulses respect `prefers-reduced-motion`; colour alone must carry the state when motion is off. Colour alone is also not the only channel — each state sets a `title`, so the states remain distinguishable without colour vision.

## Known weaknesses

- **Hook latency.** Each event runs a bash script and a curl inside Claude's turn. Over a unix socket this is sub-millisecond, and the timeouts are tight (1s connect / 2s total), but it is not free. The hooks config supports `"async": true`, which is the obvious follow-up if it ever shows; it is not used initially because its delivery semantics are unverified.
- **Global config.** We modify the user's `~/.claude/settings.json`. The env-var guard makes the script inert elsewhere, but the entries are still there and must be removable.
- **Claude only.** Other agents have their own hook schemas. The daemon's event→status mapping is the seam where another agent would slot in.
- **Fresh install ordering.** Hooks are registered at app start; a `claude` already running in a PTY from a previous session will not have them until it restarts.

## Testing

- Event→status mapping and seen-gating: pure functions, unit-tested.
- `ps` parsing and descendant walk: pure, tested against captured real output (spaces, absolute paths, the version-numbered decoy, cyclic parent chains).
- settings.json merge: unit-tested against a populated file with pre-existing user hooks, a malformed file (must abort, not clobber), and repeated installs (must be idempotent).
- The hook script itself: exercised by piping a payload with and without `WTM_TERMINAL_ID` set.
- End-to-end in the real app: start `claude`, confirm green pulse; trigger a permission prompt, confirm amber; approve and finish, confirm grey; visit the tab, confirm it clears; `kill -9` the agent mid-turn, confirm the backstop clears it.

## Out of scope

- Completion chimes and dock badges (Superset has both; separate feature).
- Agents other than `claude`.
- Agent status anywhere but the sidebar.
- Aggregating status per repo group.
