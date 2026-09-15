import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { branchForTask } from '../state/board'
import { commandPromptVars, createWorktreeCommand } from '@shared/repo-commands'
import type { RepoCommand } from '@shared/ipc-types'
import type { Task } from '@shared/tasks'

// What a task shows instead of a terminal when it doesn't own a worktree yet.
//
// Two paths, and the repo decides which: if its commands.json declares a
// command with `"role": "createWorktree"`, that runs — its own script makes the
// worktree, and its `select` / `terminal` follow-ups open tmux, start the agent
// and hand it the kickoff message. Otherwise the app falls back to plain
// `git worktree add` in the sibling convention.
export function StartPane({ task }: { task: Task }) {
  const repos = useStore(st => st.repos)
  const repo = task.repo ?? repos[0]
  const [branch, setBranch] = useState(() => branchForTask(task.title))
  // What the agent should start on. Optional: an empty kickoff means the
  // command's {{prompt}} substitutes to nothing, which is the same as opening
  // the worktree and typing it yourself.
  const [kickoff, setKickoff] = useState('')
  const [command, setCommand] = useState<RepoCommand | null>(null)
  const [extras, setExtras] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // Which flow this repo gets. Re-read when the repo changes, and on mount —
  // commands.json is edited outside the app as often as inside it.
  useEffect(() => {
    let live = true
    if (!repo) { setCommand(null); return }
    window.api.listRepoCommands(repo)
      .then(entries => { if (live) setCommand(createWorktreeCommand(entries) ?? null) })
      .catch(() => { if (live) setCommand(null) })
    return () => { live = false }
  }, [repo])

  // Placeholders the command declares that this pane can't fill in itself.
  // {{branch}} and {{prompt}} are implicit, so whatever is left is genuinely
  // the author's own and needs a box.
  const asks = command ? commandPromptVars(command) : []
  const ready = branch.trim() && asks.every(a => extras[a]?.trim())

  const start = async () => {
    if (!ready || busy) return
    setBusy(true); setError(undefined)
    const { startWorktree, startWorktreeWithCommand } = useStore.getState()
    const message = command
      ? await startWorktreeWithCommand(task.id, command, branch.trim(),
          Object.fromEntries(asks.map(a => [a, extras[a].trim()])), kickoff.trim())
      : await startWorktree(task.id, branch.trim())
    setBusy(false)
    if (message) setError(message)
  }

  return (
    <div className="wt-start">
      <span className="wt-start-big">This task has no worktree yet.</span>
      {task.worktree && (
        <span>Its previous worktree ({task.worktree}) is gone. Starting makes a new one.</span>
      )}
      <span>
        {repo
          ? <>
              {command ? <>Runs <b style={{ color: '#ddd' }}>{command.label}</b> in </> : 'Creates a branch in '}
              <b style={{ color: '#ddd' }}>{repo.split('/').filter(Boolean).pop()}</b>
              {command ? '.' : ' and a worktree beside it.'}
            </>
          : 'No repo connected yet — add one from the Repos menu first.'}
      </span>

      <div className="wt-start-row">
        <label className="wt-start-label" htmlFor={`branch-${task.id}`}>Branch</label>
        <input id={`branch-${task.id}`} className="wt-input wt-start-branch" value={branch}
               spellCheck={false} placeholder="branch name"
               onChange={e => setBranch(e.target.value)}
               onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') start() }} />
      </div>

      {asks.map(name => (
        <div className="wt-start-row" key={name}>
          <label className="wt-start-label" htmlFor={`${name}-${task.id}`}>{name}</label>
          <input id={`${name}-${task.id}`} className="wt-input wt-start-branch"
                 value={extras[name] ?? ''} spellCheck={false}
                 onChange={e => setExtras(v => ({ ...v, [name]: e.target.value }))}
                 onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') start() }} />
        </div>
      ))}

      {command && (
        <div className="wt-start-kickoff">
          <label className="wt-start-label" htmlFor={`kickoff-${task.id}`}>
            Kick off with (optional)
          </label>
          {/* Cmd+Enter starts, so Enter can still break a line: a kickoff is
              usually a sentence or two, not a single line. */}
          <textarea id={`kickoff-${task.id}`} className="wt-input wt-start-prompt" rows={3}
                    placeholder={`What should the agent start on?\ne.g. "${task.title}" — read the ticket and propose a plan`}
                    value={kickoff}
                    onChange={e => setKickoff(e.target.value)}
                    onKeyDown={e => {
                      e.stopPropagation()
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start()
                    }} />
        </div>
      )}

      <div className="wt-start-row">
        <button className="wt-btn wt-btn-primary" disabled={busy || !ready || !repo}
                onClick={start}>
          {busy ? 'Starting…' : command ? command.label : 'Start worktree'}
        </button>
      </div>
      {error && <div className="wt-start-error">{error}</div>}
      <span style={{ fontSize: 11 }}>
        Starting moves this task to In progress. Work that never needs a terminal can just stay here.
      </span>
    </div>
  )
}
