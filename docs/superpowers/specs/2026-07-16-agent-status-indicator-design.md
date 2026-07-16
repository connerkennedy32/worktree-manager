# Agent Status Indicator

## Problem

The sidebar shows what git knows about each worktree — branch, main-vs-branch icon, uncommitted change count — but nothing about what is happening *inside* the worktree's terminal. When an agent runs in several worktrees at once, there is no way to tell from the left pane which one is churning and which one has stopped and is waiting for input. You have to click through tabs to find out.

## Goal

Show, per sidebar row, whether an agent is running in that worktree's terminal and whether it is currently working or waiting on the user.

## Why two signals

The daemon spawns a plain login shell (`sessionStore.ts:14-18`); the user types `claude` themselves. Nothing in the app records that an agent exists, so presence must be discovered.

Two independent signals, neither sufficient alone:

- **Presence** — does the PTY have a descendant process named `claude`. Cannot distinguish working from waiting.
- **Output activity** — has the PTY emitted data recently. Cannot distinguish an idle shell from a waiting agent.

Gated together they resolve all three states.

Output activity works as a proxy for "working" because of a specific property of Claude Code: while thinking it renders an animated spinner and elapsed-time counter that repaint continuously, so output never goes quiet. Sitting at a prompt awaiting input, it emits nothing.

## States

| State | Condition | Meaning |
|---|---|---|
| `none` | no `claude` descendant | no agent in this worktree |
| `working` | `claude` present **and** `now - lastDataAt < 750ms` | agent is churning |
| `waiting` | `claude` present, output quiet | agent is blocked on you |

`waiting` is the actionable state: it means the tab wants your attention.

## Architecture

Detection lives in the daemon. It owns the PTYs and their pids, it outlives the Electron app, and it is the only place where both signals exist.

### Detection — `src/main/pty-daemon/agentWatcher.ts` (new)

`Session` (`sessionStore.ts:4`) gains `lastDataAt: number`, stamped in the existing `proc.onData` handler (`sessionStore.ts:20`). One assignment; the handler already runs on every chunk.

Every 2s the watcher:

1. Runs one `ps -axo pid,ppid,comm` for **all** sessions — flat cost regardless of worktree count.
2. Builds a child→parent map from the output.
3. For each session, walks descendants of `proc.pid` for a command matching `claude`.
4. Resolves each session to `none` / `working` / `waiting` per the table above.

Split into two units so the logic is testable without PTYs:

- `parseProcessTable(psOutput: string): ProcEntry[]` — pure parse.
- `resolveStatus(entries, rootPid, lastDataAt, now): AgentStatus` — pure decision.

The watcher itself only wires these to a timer and the broadcast.

### Matching a `claude` process

Observed `ps -axo pid,ppid,comm` output on this machine rules out a naive
substring match. Three real shapes:

```
15820 11275 claude                                          <- interactive, shell-launched
54405 54052 /Users/connerkennedy/.local/bin/claude          <- comm is an absolute path
22867 22772 claude bg-pty-host                              <- comm contains spaces
77291     1 /Users/connerkennedy/.local/share/claude/versions/2.1.201
```

Consequences:

- **Parse pid, ppid, and rest-of-line.** `comm` can contain spaces, so
  splitting the line on whitespace corrupts it. Take the first two
  whitespace-separated fields as numbers; everything after is `comm`.
- **Match on `basename(firstToken(comm)) === 'claude'`.** This catches the
  bare, absolute-path, and space-suffixed forms.
- **The version-numbered form is deliberately not matched.** Every such
  process has `ppid 1` — they are Claude's own daemon/background
  infrastructure, reparented to launchd, and sit in a subtree the descendant
  walk never enters. Matching them would risk lighting up every row from a
  single unrelated daemon.

A shell-launched `claude` is a true descendant of the PTY's shell (verified:
`claude` 15820 → `-zsh` 11275), so the descendant walk is sound for the
interactive case that matters.

Match `claude` only. Widening the match later is a one-line change; each extra name is another chance for a false positive.

### Transport

New `ServerMessage` variant in `protocol.ts`:

```ts
| { type: 'agentStatus'; path: string; status: AgentStatus }
```

`AgentStatus = 'none' | 'working' | 'waiting'`, declared in `shared/ipc-types.ts` alongside `WorktreeStatus`.

Broadcast **only on change** — a stable tab costs zero traffic. On client connect the daemon sends the current status for every live session, so a reloaded window is not blank until the next transition.

`client.ts` forwards to the renderer over a new IPC channel, following the existing terminal-channel pattern (`ipc-types.ts:68-74`, `88-91`).

### Renderer

`store.ts` gains `agentStatuses: Record<string, AgentStatus>`, mirroring the existing `statuses` map (`store.ts:69-72`). Populated from the pushed event. It does **not** join the 3s poll loop at `store.ts:49` — that loop only refreshes the selected worktree, whereas this indicator is needed on every row, and the push already covers it.

`Sidebar.tsx` renders `<AgentDot status={...}/>` at the leading edge next to `MainDotIcon`/`BranchIcon` (line 134), clear of the right-side badge cluster (lines 142-148) where the change-count badge and hover-✕ already compete for space.

- `working` — pulsing dot
- `waiting` — static dim dot
- `none` — renders nothing

The pulse respects `prefers-reduced-motion`, falling back to a solid color so the state stays legible without animation. Styles go in `sidebar-theme.css` beside `.wt-badge`.

## Known weakness

`working` rests on Claude Code repainting continuously. If it ever works while emitting nothing for >750ms, the dot briefly reads `waiting`.

This is the benign direction: it self-corrects on the next repaint, and the failure is a momentary flicker rather than a wrong tab. The 750ms threshold is the knob if it proves twitchy in practice.

Output activity also fires on user keystroke echo, which would read as `working` while typing. Harmless — you are looking at that tab.

## Testing

- `parseProcessTable` — against captured real `ps -axo pid,ppid,comm` output, including the header line and commands containing spaces.
- `resolveStatus` — fabricated process tables covering: no descendants; `claude` as a direct child; `claude` nested under an intermediate process; a non-agent descendant; recent vs. stale `lastDataAt` at the 750ms boundary.
- Change-only broadcast — repeated identical resolutions emit one message.
- End-to-end in the real app: start `claude` in one worktree, confirm the dot pulses; let it finish, confirm it goes static; exit, confirm it disappears; confirm an untouched worktree's row never lights up.

## Out of scope

- Configurable agent-name list (YAGNI for a one-name match).
- Agent status anywhere but the sidebar.
- Distinguishing *why* an agent is waiting (permission prompt vs. finished).
