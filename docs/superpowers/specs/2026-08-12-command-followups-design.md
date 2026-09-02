# Repo command follow-ups: select a worktree and type into its terminal

## Problem

Starting work on a Linear ticket is five manual steps: click the create-worktree
button, type the branch name Linear gave you, click the new worktree in the
sidebar, type `tmux`, type `cc`, then paste the ticket reference and "solve
this". Every step after the first is mechanical and always the same.

## Goal

Type the branch name into the create dialog already in use, press Enter, and
land in a tmux session inside the new worktree with Claude Code already working
the ticket. The branch name (e.g. `conner/roo-1234-fix-the-thing`) carries the
issue identifier, so it is both the worktree name and the prompt context — no
Linear URL, API token, or MCP connection is involved.

## Design

Worktree creation is already a user-configured repo command, so the feature is
built as two optional fields on any repo command rather than a purpose-built
button. Anything else configured in the commands file gains the same power.

### Config surface

```json
{
  "label": "New worktree",
  "run": "git worktree add --no-track -b {{name}} ../.worktrees/{{name}} main",
  "select": "../.worktrees/{{name}}",
  "terminal": ["tmux new -s {{name}} \\; send-keys 'cc \"{{name}} solve this\"' Enter"]
}
```

- **`select`** (string, optional) — a path to select in the sidebar after the
  command succeeds. Resolved against the command's effective `cwd` (the repo
  root when `cwd: "repo"`, otherwise the worktree the command ran in), then
  matched against the refreshed worktree list by resolved real path.
- **`terminal`** (string array, optional) — lines typed into the selected
  worktree's terminal, each followed by Enter.

Both fields run through the existing placeholder substitution and share its
variables (`{{name}}` and other prompt vars, plus `worktree`, `worktreeName`,
`repo`, `branch`, `message`). `terminal` lines use the shell-quoting variant only
when the command itself sets `shell: true`; otherwise values are inserted
literally, matching how `run` behaves in the same mode. `select` is always
substituted literally regardless of `shell`, because it is a path rather than a
command line — quoting it would embed quote characters and guarantee no match.

Both are validated per-entry by `isRepoCommand`: a `select` that is not a
non-empty string, or a `terminal` that is not an array of non-empty strings,
makes that one entry invalid and it is dropped — consistent with today's
behavior, where a malformed entry never breaks the rest of the file.

### Execution flow

After `runRepoCommand` returns `ok`:

1. Refresh the worktree list for the repo, so a just-created worktree is known.
2. If `select` is set, resolve it and find the matching worktree. Select it,
   which brings up that worktree's persistent pty.
3. If `terminal` is set, send its lines to the selected worktree's pty in order,
   each terminated with `\r`.

If `select` is absent, `terminal` lines go to whatever worktree is currently
selected. If `select` is set but matches no worktree, the command still reports
success, nothing is selected, and no lines are typed.

### Timing

The hazard is typing a second line before the first has produced a shell ready
to receive it — most concretely, `cc` arriving before tmux's shell exists, which
sends the keystrokes somewhere unintended.

Two mitigations, in order of reliability:

1. **Recommended config** collapses the chain into one line and lets tmux
   deliver the inner keys itself, so no timing assumption is made at all:
   `tmux new -s {{name}} \; send-keys '...' Enter`.
2. For multi-line `terminal` values, the app waits for the pty to go quiet — no
   output for 250ms — before sending each subsequent line, capped at 2s so a
   continuously-chatty program cannot stall the sequence. The cap means a
   long-running noisy first line can still be raced; the one-line form above is
   the answer for anything timing-sensitive.

### Error handling

A failed command selects nothing and types nothing; its existing error message
is unchanged. Follow-ups are best-effort and never turn a successful command
into a reported failure — a missing worktree or an unavailable pty is a no-op.

## Testing

- Parsing: valid `select`/`terminal` survive; malformed values drop the entry.
- Substitution: placeholders resolve in both fields, in shell and non-shell mode.
- Path matching: relative `select` resolves against repo-cwd and worktree-cwd
  commands, and an unmatched path is a no-op.
- Sequencing: against a fake pty, lines are sent in order with Enter, the next
  line waits for quiet, and the wait is bounded by the cap.

tmux's own behavior is verified by hand, not in the suite.

## Out of scope

- Deriving the worktree name from a Linear URL or the Linear API.
- Any Claude-specific handling; `cc` is just a line of text from the config.
- Configurable wait timings — the two constants are fixed until they prove wrong.
