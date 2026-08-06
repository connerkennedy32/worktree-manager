import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { useChangedFiles, codeColor, type Row, type SectionId } from './changed-files'
import { InputsPromptModal } from './InputsPromptModal'
import type { RepoCommand, RepoCommandEntry } from '@shared/ipc-types'
import { isCommandGroup } from '@shared/ipc-types'
import { promptVars } from '@shared/repo-commands'
import './diff-panel.css'

// Stroked icons rather than the glyphs this panel used to borrow from the text
// font (⟳ ⧉ ↩ ▸): those render at whatever weight and baseline the font
// happens to give them, which is why the action row never looked level.
const Icon = ({ d, size = 13 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor"
       strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)
const ICONS = {
  chevron: 'M6 3.5 10.5 8 6 12.5',
  sync: 'M13.5 7a5.5 5.5 0 1 0-1.2 4.3M13.5 3v4h-4',
  copy: 'M5.5 5.5V3.75A1.25 1.25 0 0 1 6.75 2.5h5.5a1.25 1.25 0 0 1 1.25 1.25v5.5a1.25 1.25 0 0 1-1.25 1.25H10.5M3.75 5.5h5.5a1.25 1.25 0 0 1 1.25 1.25v5.5a1.25 1.25 0 0 1-1.25 1.25h-5.5A1.25 1.25 0 0 1 2.5 12.25v-5.5A1.25 1.25 0 0 1 3.75 5.5Z',
  check: 'M3 8.5 6.5 12 13 4.5',
  close: 'M4 4l8 8M12 4l-8 8',
  terminal: 'M3.5 4.5 6.5 8l-3 3.5M8.5 11.5h4',
  push: 'M8 13V3.5M8 3.5 4.5 7M8 3.5 11.5 7',
  plus: 'M8 4v8M4 8h8',
  minus: 'M4 8h8',
  undo: 'M3 8h7a3 3 0 0 1 0 6H7M3 8l3-3M3 8l3 3',
  play: 'M5.5 3.5 12 8l-6.5 4.5Z',
  // A caret in a field: this button opens a prompt before it runs anything.
  prompt: 'M2.5 3.5h11v9h-11zM5 6.5 7 8l-2 1.5M8.5 9.5h3'
} as const

// Diffs are not rendered here — clicking a row opens DiffModal. This panel is the
// file list, the staging surface, and the commit box.
export function DiffPanel({ collapsed, onToggle, width = 460 }:
  { collapsed: boolean; onToggle: () => void; width?: number }) {
  const selected = useStore(s => s.selected)
  const refreshStatus = useStore(s => s.refreshStatus)
  const refreshWorktrees = useStore(s => s.refreshWorktrees)
  const setOpenDiff = useStore(s => s.setOpenDiff)
  const worktrees = useStore(s => s.worktrees)
  const branch = worktrees.find(w => w.path === selected)?.branch

  const { stagedRows, unstagedRows, committedRows, committed, stagedCount, total } =
    useChangedFiles(selected)

  const [msg, setMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [pending, setPending] = useState(0)
  const [pushing, setPushing] = useState(false)
  // Shared by push and sync: both are network git operations that report back in
  // the same banner, and only one runs at a time.
  const [result, setResult] = useState<{
    ok: boolean
    message: string
    source: 'sync' | 'push' | 'command'
  }>()
  const [syncing, setSyncing] = useState(false)
  // Identified by position ("2", or "2.1" inside a group), not by label: the
  // same command may legitimately appear both loose and inside a group, and
  // keying this by label would light up both buttons and make React's list keys
  // collide.
  const [running, setRunning] = useState<{ id: string; label: string }>()
  const [commands, setCommands] = useState<RepoCommandEntry[]>([])
  // Which command groups are expanded, keyed by group label. Kept per session
  // rather than seeded fresh from `open` on every worktree switch, so a group
  // you opened stays open while you move between worktrees of the same repo.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  // A configured command awaiting the values for its {{placeholders}}.
  const [prompt, setPrompt] = useState<{ id: string; cmd: RepoCommand }>()
  const [copied, setCopied] = useState(false)
  // Live git output for the running action. Undefined means no popout.
  const [terminal, setTerminal] = useState<string>()
  const terminalRef = useRef<HTMLPreElement>(null)

  // Commits this worktree has that the remote doesn't. Fetched on demand rather
  // than carried on WorktreeStatus: getStatus already runs for every *watched*
  // worktree several times a second, and only the selected one shows this count.
  const status = useStore(s => (selected ? s.statuses[selected] : undefined))
  useEffect(() => {
    if (!selected) { setPending(0); return }
    let cancelled = false
    // Keyed on `status` too: it's a fresh object per refreshStatus, so the count
    // re-fetches after a commit, a watcher event, or the 3s poll.
    window.api.getPendingCount(selected).then(n => { if (!cancelled) setPending(n) })
    return () => { cancelled = true }
  }, [selected, status])

  // A result from one worktree must not linger over another.
  useEffect(() => { setResult(undefined); setTerminal(undefined) }, [selected])

  // Re-read on every worktree switch and whenever the editor writes the file,
  // so a command you just added is on the panel before the modal has finished
  // closing.
  useEffect(() => {
    if (!selected) { setCommands([]); return }
    let cancelled = false
    const load = () => window.api.listRepoCommands(selected)
      .then(c => { if (!cancelled) setCommands(c) })
    load()
    const off = window.api.onCommandsChanged(load)
    return () => { cancelled = true; off() }
  }, [selected])

  // Chunks arrive as git writes them, so the popout fills in during a slow
  // fetch instead of appearing complete at the end. Output for a worktree you
  // aren't looking at is dropped rather than shown under the wrong branch.
  useEffect(() => {
    return window.api.onGitOutput((worktreePath, chunk) => {
      if (worktreePath !== selected) return
      setTerminal(prev => (prev ?? '') + chunk)
    })
  }, [selected])

  // Pin to the newest line, the way a terminal scrolls.
  useEffect(() => {
    const el = terminalRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [terminal])

  // Success is an acknowledgement, so it clears itself. Failures stay until
  // dismissed — git's message is the only record of what went wrong.
  useEffect(() => {
    if (!result?.ok) return
    const t = setTimeout(() => setResult(undefined), 5000)
    return () => clearTimeout(t)
  }, [result])
  // Working changes are the panel's job, so they start open; committed files are
  // reference material and start collapsed.
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>(
    { staged: true, unstaged: true, committed: false })

  useEffect(() => {
    setOpenSections({ staged: true, unstaged: true, committed: false })
  }, [selected])

  const stageRow = async (row: Row) => {
    if (!selected) return
    await window.api.stagePath({ worktreePath: selected, path: row.path, unstage: row.staged })
    await refreshStatus(selected)
  }

  const stageAll = async () => {
    if (!selected) return
    await window.api.stageAll(selected)
    await refreshStatus(selected)
  }

  // Discarding throws work away irrecoverably, so it must confirm first.
  const discardRow = async (row: Row) => {
    if (!selected) return
    if (!window.confirm(`Discard all changes to ${row.path}? This cannot be undone.`)) return
    await window.api.discardPath({ worktreePath: selected, path: row.path })
    await refreshStatus(selected)
  }

  const doCommit = async () => {
    if (!selected || !msg.trim()) return
    setCommitting(true)
    try {
      await window.api.commit({ worktreePath: selected, message: msg.trim() })
      setMsg('')
      await refreshStatus(selected)
    } finally { setCommitting(false) }
  }

  // Unlike doCommit, this must surface failure: a silently failed push looks
  // exactly like a successful one, and you'd believe your work was on the remote.
  const doPush = async () => {
    if (!selected) return
    setPushing(true)
    setResult(undefined)
    try {
      const outcome = await window.api.push(selected)
      if (outcome.ok) {
        setResult({ ok: true, source: 'push', message: `Pushed ${pending} commit${pending === 1 ? '' : 's'}.` })
        await refreshStatus(selected)
      } else setResult({ ok: false, source: 'push', message: outcome.message })
    } finally { setPushing(false) }
  }

  // Merge conflicts come back as a failed outcome, but the working tree has
  // still changed — so refresh either way.
  const doSync = async () => {
    if (!selected) return
    setSyncing(true)
    setResult(undefined)
    // Empty string, not undefined: the popout should open immediately so a slow
    // fetch has somewhere to appear, rather than after the first chunk lands.
    setTerminal('')
    try {
      setResult({ ...await window.api.syncWithTrunk(selected), source: 'sync' })
      await refreshStatus(selected)
    } finally { setSyncing(false) }
  }

  // A configured command can do anything — create a worktree, run a gate — so
  // both the worktree list and the status are refreshed after every one.
  const doRepoCommand = async (id: string, command: RepoCommand, inputs?: Record<string, string>) => {
    if (!selected) return
    setRunning({ id, label: command.label })
    setResult(undefined)
    setTerminal('')
    try {
      const outcome = await window.api.runRepoCommand({
        worktreePath: selected, command, inputs, message: msg.trim(), branch
      })
      setResult({ ...outcome, source: 'command' })
      await refreshStatus(selected)
      await refreshWorktrees()
    } finally { setRunning(undefined) }
  }

  const startRepoCommand = (id: string, command: RepoCommand) => {
    if (promptVars(command.run).length) setPrompt({ id, cmd: command })
    else doRepoCommand(id, command)
  }

  // Shared by the top-level buttons and the ones inside a group, so a grouped
  // command behaves identically to an ungrouped one.
  const commandButton = (cmd: RepoCommand, id: string): ReactNode => {
    // Clicking this one opens a dialog rather than running immediately, which
    // is worth knowing before you click — especially next to buttons that fire
    // straight away.
    const asks = promptVars(cmd.run)
    return (
      <button key={id} className="dp-action" onClick={() => startRepoCommand(id, cmd)}
              disabled={!selected || busy}
              style={cmd.width === 'full' ? { gridColumn: '1 / -1' } : undefined}
              title={`${cmd.run}${cmd.cwd === 'repo' ? '  (in the repo root)' : ''}` +
                     (asks.length ? `\n\nAsks for ${asks.join(', ')} first` : '')}>
        {/* The pulsing dot replaces the glyph while it runs, so the label keeps
            its full width instead of gaining a trailing ellipsis. */}
        {running?.id === id
          ? <span className="dp-pulse" />
          : <span className="dp-action-glyph"><Icon d={ICONS.play} size={11} /></span>}
        <span className="dp-action-label">{cmd.label}</span>
        {asks.length > 0 && running?.id !== id && (
          <span className="dp-action-asks" aria-label={`Asks for ${asks.join(', ')}`}>
            <Icon d={ICONS.prompt} size={11} />
          </span>
        )}
      </button>
    )
  }

  // The command the Sync button runs, for pasting into a terminal. Falls back to
  // origin/main before the committed-files fetch has resolved the real base.
  const base = committed?.baseBranch || 'origin/main'
  const syncCommand = base.startsWith('origin/')
    ? `git fetch origin ${base.slice('origin/'.length)} && git merge --no-edit ${base}`
    : `git merge --no-edit ${base}`

  // A successful sync reports inside its own button, so the message is trimmed
  // to what fits: the file count and trailing period live in the tooltip.
  const syncSuccess = result?.ok && result.source === 'sync'
    ? result.message.replace(/,.*$/, '').replace(/\.$/, '')
    : undefined

  // The action row shares one result banner and one terminal popout, so only one
  // of these commands may run at a time.
  const busy = syncing || running !== undefined

  const copySyncCommand = () => {
    // navigator.clipboard is absent in the packaged app (file:// is not a secure
    // context), so the copy goes through Electron's clipboard in the preload.
    // Kept in a try so a failure can't also swallow the visible feedback.
    try { window.api.copyText(syncCommand) } catch (e) { console.error('copy failed', e) }
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const renderRow = (row: Row) => (
    <div key={row.key} className="dp-row" onClick={() => setOpenDiff(row)} title={row.path}>
      <span className="dp-row-code" style={{ color: codeColor(row.code) }}
            title={row.committed ? 'committed' : row.staged ? 'staged' : 'unstaged'}>
        {row.code}
      </span>
      <span className="dp-row-path">{row.path}</span>
      {(row.add || row.del) && (
        <span className="dp-row-stat">
          {row.add ? <span style={{ color: '#6a9955' }}>+{row.add}</span> : null}
          {row.del ? <span style={{ color: '#c94a4a' }}>−{row.del}</span> : null}
        </span>
      )}
      {/* Staging and discarding an already-committed file are both meaningless. */}
      {!row.committed && (
        <span className="dp-row-actions">
          <button className="dp-icon-btn danger" title="Discard changes"
                  onClick={e => { e.stopPropagation(); discardRow(row) }}>
            <Icon d={ICONS.undo} size={12} />
          </button>
          <button className="dp-icon-btn" title={row.staged ? 'Unstage' : 'Stage'}
                  onClick={e => { e.stopPropagation(); stageRow(row) }}>
            <Icon d={row.staged ? ICONS.minus : ICONS.plus} size={12} />
          </button>
        </span>
      )}
    </div>
  )

  const renderSection = (id: SectionId, label: string, sectionRows: Row[], action?: ReactNode) => {
    if (sectionRows.length === 0) return null
    const open = openSections[id]
    return (
      <>
        <div className="dp-section" onClick={() => setOpenSections(s => ({ ...s, [id]: !s[id] }))}>
          <span className={`dp-chevron${open ? ' open' : ''}`}><Icon d={ICONS.chevron} size={11} /></span>
          <span className="dp-section-label">{label}</span>
          {action}
          <span className="dp-group-count">{sectionRows.length}</span>
        </div>
        {open && sectionRows.map(renderRow)}
      </>
    )
  }

  if (collapsed) {
    return (
      <div className="dp-rail" onClick={onToggle} title="Show changes">
        <span className="dp-chevron" style={{ transform: 'rotate(180deg)' }}>
          <Icon d={ICONS.chevron} size={12} />
        </span>
        <span className="dp-rail-label">Changes</span>
        {total > 0 && <span className="dp-rail-count">{total}</span>}
      </div>
    )
  }

  return (
    <div className="dp-panel" style={{ width }}>
      <div className="dp-header">
        <button className="dp-icon-btn" onClick={onToggle} title="Collapse">
          <Icon d={ICONS.chevron} size={12} />
        </button>
        <span className="dp-title">
          <span className="dp-title-name">Changes</span>
          {branch && <span className="dp-title-branch" title={branch}>{branch}</span>}
        </span>
        {selected && (
          <button className="dp-action" style={{ flex: 'none', padding: '3px 9px' }}
                  onClick={() => window.api.openInEditor(selected)} title="Open worktree in VS Code">
            VS Code
          </button>
        )}
        {total > 0 && (
          <span className="dp-count" title={`${stagedCount} of ${total} changed files staged`}>
            <strong>{stagedCount}</strong>/{total}
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!selected && <div className="dp-empty">Select a worktree.</div>}
        {selected && total === 0 && (
          <div className="dp-empty">{committedRows.length ? 'No working changes.' : 'No changes.'}</div>
        )}
        {renderSection('staged', 'Staged', stagedRows)}
        {renderSection('unstaged', 'Unstaged', unstagedRows,
          <button className="dp-section-action" title="Stage all"
                  onClick={e => { e.stopPropagation(); stageAll() }}>
            Stage all
          </button>)}
        {renderSection('committed', `Committed vs ${committed?.baseBranch ?? ''}`, committedRows)}
      </div>

      {/* The footer is two halves separated by a hairline: things you run
          (sync, branch, repo commands) above, and the commit-and-push flow
          below. They were one undifferentiated stack of buttons before, which
          is why the primary action never stood out. */}
      <div className="dp-footer">
        {terminal !== undefined && (
          // Anchored to the action row rather than inline: it can be tall, and
          // pushing the commit box down mid-sync would move the buttons under
          // the cursor. Sticks around after the command finishes so the output
          // is readable; dismissed by hand or by the next run.
          <div style={{ position: 'relative' }}>
            <div className="dp-terminal">
              <div className="dp-terminal-bar">
                <Icon d={ICONS.terminal} size={11} />
                <span style={{ flex: 1 }}>{running?.label ?? 'Terminal'}</span>
                {busy && <span className="dp-pulse" />}
                <button className="dp-icon-btn" onClick={() => setTerminal(undefined)} title="Hide">
                  <Icon d={ICONS.close} size={10} />
                </button>
              </div>
              <pre ref={terminalRef} className="dp-terminal-out">{terminal || 'Starting…'}</pre>
            </div>
          </div>
        )}

        {/* Two equal columns: labels stay readable and nothing reflows when one
            changes length (`Sync with master` on a master repo). */}
        <div className="dp-actions">
          {/* Two sibling buttons sharing one surface, rather than a copy control
              nested inside the sync button: a disabled <button> swallows clicks
              on everything inside it, so while no worktree is selected — or
              during a sync — the nested copy icon received no events at all. */}
          <div className="dp-split">
            <button className={`dp-action${syncSuccess ? ' ok' : ''}`} onClick={doSync}
                    disabled={!selected || busy}
                    title={syncSuccess ? result!.message : `Fetch and merge ${base} into this branch`}>
              {syncing
                ? <span className="dp-pulse" />
                : <span className="dp-action-glyph">
                    <Icon d={syncSuccess ? ICONS.check : ICONS.sync} size={12} />
                  </span>}
              {/* The outcome replaces the label for a few seconds rather than
                  claiming its own row, so the commit box never moves. */}
              <span className="dp-action-label">
                {syncing ? 'Syncing…' : syncSuccess ?? `Sync ${base.replace('origin/', '')}`}
              </span>
            </button>
            <button className={`dp-icon-btn${copied ? ' ok' : ''}`} onClick={copySyncCommand}
                    aria-label="Copy sync command" title={`Copy: ${syncCommand}`}>
              <Icon d={copied ? ICONS.check : ICONS.copy} size={12} />
            </button>
          </div>

          {commands.map((entry: RepoCommandEntry, i: number) => {
            if (!isCommandGroup(entry)) return commandButton(entry, String(i))
            const open = openGroups[entry.label] ?? entry.open ?? false
            // Spans both columns so the container reads as a section rather than
            // a button that happens to be wide, and its own grid keeps the
            // buttons inside on the same two-column rhythm as the ones outside.
            return (
              <div key={`group:${i}`} className={`dp-group${open ? ' open' : ''}`}>
                <button className="dp-group-header"
                        onClick={() => setOpenGroups(g => ({ ...g, [entry.label]: !open }))}
                        title={`${entry.commands.length} command${entry.commands.length === 1 ? '' : 's'}`}>
                  <span className={`dp-chevron${open ? ' open' : ''}`}>
                    <Icon d={ICONS.chevron} size={11} />
                  </span>
                  <span className="dp-group-label">{entry.label}</span>
                  {/* While collapsed, a running command inside would otherwise
                      give no sign it is running at all. */}
                  {!open && entry.commands.some((_, j) => running?.id === `${i}.${j}`)
                    ? <span className="dp-pulse" />
                    : <span className="dp-group-count">{entry.commands.length}</span>}
                </button>
                {open && (
                  <div className="dp-group-body">
                    {entry.commands.map((cmd, j) => commandButton(cmd, `${i}.${j}`))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="dp-sep" />

        {prompt && (
          <InputsPromptModal title={prompt.cmd.label}
                             hint={prompt.cmd.run}
                             fields={promptVars(prompt.cmd.run)}
                             confirmLabel="Run"
                             onSubmit={values => doRepoCommand(prompt.id, prompt.cmd, values)}
                             onClose={() => setPrompt(undefined)} />
        )}

        {/* Message, subject and action in one card. The count sits beside the
            button it qualifies — "commit what?" is answered where it's asked,
            rather than only in the panel header. */}
        <div className="dp-composer">
          <textarea className="dp-message" placeholder="Commit message" rows={2}
                    value={msg} onChange={e => setMsg(e.target.value)} />
          <div className="dp-composer-bar">
            <span className="dp-composer-meta">
              {stagedCount === 0
                ? total === 0 ? 'Nothing to commit' : 'Nothing staged'
                : <><strong>{stagedCount}</strong> file{stagedCount === 1 ? '' : 's'} staged</>}
            </span>
            <button className="dp-primary" onClick={doCommit}
                    disabled={committing || !msg.trim() || stagedCount === 0}
                    title={stagedCount === 0 ? 'Stage a file first'
                      : !msg.trim() ? 'Type a commit message' : `Commit ${stagedCount} staged file(s)`}>
              {committing ? 'Committing…' : 'Commit'}
            </button>
          </div>
        </div>

        {pending > 0 && (
          <button className="dp-primary subtle dp-push" onClick={doPush} disabled={pushing}>
            {pushing ? <span className="dp-pulse" /> : <Icon d={ICONS.push} size={12} />}
            {pushing ? 'Pushing…' : `Push ${pending} commit${pending === 1 ? '' : 's'}`}
          </button>
        )}

        {/* Sync success is shown inline on its button; everything else needs the
            room — git's failure output is multi-line, and a push that succeeds
            takes its own button away with it. */}
        {result && !syncSuccess && (
          <div className={`dp-banner ${result.ok ? 'ok' : 'bad'}`}>
            <span style={{ flexShrink: 0, paddingTop: 1 }}>
              <Icon d={result.ok ? ICONS.check : ICONS.close} size={11} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>{result.message}</span>
            <button className="dp-icon-btn" onClick={() => setResult(undefined)} title="Dismiss">
              <Icon d={ICONS.close} size={10} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
