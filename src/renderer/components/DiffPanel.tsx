import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { useChangedFiles, codeColor, type Row, type SectionId } from './changed-files'
import { InputsPromptModal } from './InputsPromptModal'
import type { RepoCommand } from '@shared/ipc-types'
import { promptVars } from '@shared/repo-commands'

// The outlined style shared by the action-row buttons, matching the header's
// VS Code button.
const actionButton: React.CSSProperties = {
  background: 'none', border: '1px solid #444', borderRadius: 4, color: '#ddd',
  cursor: 'pointer', fontSize: 11, padding: '5px 8px', whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis'
}

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
    source: 'sync' | 'push' | 'branch' | 'command'
  }>()
  const [syncing, setSyncing] = useState(false)
  const [running, setRunning] = useState<string>()
  const [commands, setCommands] = useState<RepoCommand[]>([])
  // Either the gt-create prompt, or a configured command awaiting its input.
  const [prompt, setPrompt] = useState<'branch' | RepoCommand>()
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

  useEffect(() => {
    if (!selected) { setCommands([]); return }
    let cancelled = false
    window.api.listRepoCommands(selected).then(c => { if (!cancelled) setCommands(c) })
    return () => { cancelled = true }
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

  // gt create commits what's staged, so with nothing staged it would make an
  // empty branch and leave the work behind — stage everything in that case.
  const doGtCreate = async (branch: string) => {
    if (!selected) return
    setRunning('gt create')
    setResult(undefined)
    setTerminal('')
    try {
      const outcome = await window.api.gtCreate({
        worktreePath: selected, branch, message: msg.trim(), stageAll: stagedCount === 0
      })
      setResult({ ...outcome, source: 'branch' })
      if (outcome.ok) setMsg('')
      await refreshStatus(selected)
      await refreshWorktrees()
    } finally { setRunning(undefined) }
  }

  // A configured command can do anything — create a worktree, run a gate — so
  // both the worktree list and the status are refreshed after every one.
  const doRepoCommand = async (command: RepoCommand, inputs?: Record<string, string>) => {
    if (!selected) return
    setRunning(command.label)
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

  const startRepoCommand = (command: RepoCommand) => {
    if (promptVars(command.run).length) setPrompt(command)
    else doRepoCommand(command)
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
    <div key={row.key} onClick={() => setOpenDiff(row)} title={row.path}
         style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
                  borderBottom: '1px solid #2a2a2a', background: 'rgba(37, 37, 38, 0.5)',
                  fontSize: 12, cursor: 'pointer' }}>
      <span title={row.committed ? 'committed' : row.staged ? 'staged' : 'unstaged'}
            style={{ color: codeColor(row.code), width: 12, textAlign: 'center' }}>{row.code}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                     direction: 'rtl', textAlign: 'left' }}>{row.path}</span>
      {(row.add || row.del) && (
        <span style={{ flexShrink: 0, display: 'flex', gap: 5, fontFamily: 'Menlo, monospace',
                       fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
          {row.add ? <span style={{ color: '#6a9955' }}>+{row.add}</span> : null}
          {row.del ? <span style={{ color: '#c94a4a' }}>−{row.del}</span> : null}
        </span>
      )}
      {/* Staging and discarding an already-committed file are both meaningless. */}
      {!row.committed && (
        <>
          <button onClick={e => { e.stopPropagation(); discardRow(row) }}
                  title="Discard changes"
                  style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                           fontSize: 15, lineHeight: 1, padding: '0 2px', width: 18 }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#f28b82')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#999')}>
            ↩
          </button>
          <button onClick={e => { e.stopPropagation(); stageRow(row) }}
                  title={row.staged ? 'Unstage' : 'Stage'}
                  style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                           fontSize: 15, lineHeight: 1, padding: '0 2px', width: 18 }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#999')}>
            {row.staged ? '−' : '+'}
          </button>
        </>
      )}
    </div>
  )

  const renderSection = (id: SectionId, label: string, sectionRows: Row[], action?: ReactNode) => {
    if (sectionRows.length === 0) return null
    const open = openSections[id]
    return (
      <>
        <div onClick={() => setOpenSections(s => ({ ...s, [id]: !s[id] }))}
             style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer',
                      position: 'sticky', top: 0, zIndex: 1,
                      borderTop: '1px solid #333', borderBottom: '1px solid #2a2a2a',
                      background: '#2d2d2d', fontSize: 11, fontWeight: 600,
                      letterSpacing: 0.5, textTransform: 'uppercase', color: '#bbb' }}>
          <span style={{ width: 12, color: '#888' }}>{open ? '▾' : '▸'}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          {action}
          <span style={{ color: '#888', fontWeight: 400 }}>{sectionRows.length}</span>
        </div>
        {open && sectionRows.map(renderRow)}
      </>
    )
  }

  if (collapsed) {
    return (
      <div onClick={onToggle} title="Show changes"
           style={{ width: 34, borderLeft: '1px solid #333', background: 'rgba(30, 30, 30, 0.55)', color: '#ddd',
                    cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center',
                    paddingTop: 10, gap: 8, flexShrink: 0, fontFamily: 'system-ui' }}>
        <span style={{ fontSize: 14 }}>‹</span>
        <span style={{ writingMode: 'vertical-rl', fontSize: 12, letterSpacing: 1 }}>
          CHANGES{total ? ` (${total})` : ''}
        </span>
      </div>
    )
  }

  return (
    <div style={{ width, borderLeft: '1px solid #333', background: 'rgba(30, 30, 30, 0.55)', color: '#d4d4d4',
                  display: 'flex', flexDirection: 'column', flexShrink: 0, fontFamily: 'system-ui' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #333', display: 'flex',
                    alignItems: 'center', gap: 8, fontSize: 12 }}>
        <button onClick={onToggle} title="Collapse" style={{ background: 'none', border: 'none',
                color: '#ddd', cursor: 'pointer', fontSize: 14 }}>›</button>
        <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Changes {branch ? `· ${branch}` : ''}
        </span>
        {selected && (
          <button onClick={() => window.api.openInEditor(selected)} title="Open worktree in VS Code"
                  style={{ background: 'none', border: '1px solid #444', borderRadius: 4, color: '#ddd',
                           cursor: 'pointer', fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#3c424e' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
            VS Code
          </button>
        )}
        <span style={{ color: '#888' }}>{stagedCount}/{total} staged</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!selected && <div style={{ padding: 12, color: '#888', fontSize: 12 }}>Select a worktree.</div>}
        {selected && total === 0 && (
          <div style={{ padding: 12, color: '#888', fontSize: 12 }}>
            {committedRows.length ? 'No working changes.' : 'No changes.'}
          </div>
        )}
        {renderSection('staged', 'Staged', stagedRows)}
        {renderSection('unstaged', 'Unstaged', unstagedRows,
          <button onClick={e => { e.stopPropagation(); stageAll() }} title="Stage all"
                  style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                           fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                           letterSpacing: 0.5, padding: '0 2px' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#999')}>
            Stage all
          </button>)}
        {renderSection('committed', `Committed vs ${committed?.baseBranch ?? ''}`, committedRows)}
      </div>

      <div style={{ borderTop: '1px solid #333', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* Two equal columns: labels stay readable and nothing reflows when one
            changes length (`Sync with master` on a master repo). */}
        {terminal !== undefined && (
          // Anchored to the action row rather than inline: it can be tall, and
          // pushing the commit box down mid-sync would move the buttons under
          // the cursor. Sticks around after the command finishes so the output
          // is readable; dismissed by hand or by the next run.
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', bottom: 4, left: 0, right: 0, zIndex: 3,
                          background: '#141415', border: '1px solid #3d3d3d', borderRadius: 4,
                          boxShadow: '0 6px 18px rgba(0, 0, 0, 0.5)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
                            borderBottom: '1px solid #2c2c2c', fontSize: 10.5, letterSpacing: 0.5,
                            textTransform: 'uppercase', color: '#8a8a8a' }}>
                <span style={{ flex: 1 }}>Terminal{busy ? ' · running' : ''}</span>
                <button onClick={() => setTerminal(undefined)} title="Hide"
                        style={{ background: 'none', border: 'none', color: '#8a8a8a',
                                 cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>
                  ×
                </button>
              </div>
              <pre ref={terminalRef}
                   style={{ margin: 0, padding: '6px 8px', maxHeight: 180, overflow: 'auto',
                            fontFamily: 'Menlo, monospace', fontSize: 11, lineHeight: 1.5,
                            color: '#cfcfcf', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {terminal || 'Starting…'}
              </pre>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {/* Two sibling buttons sharing one border, rather than a copy control
              nested inside the sync button: a disabled <button> swallows clicks
              on everything inside it, so while no worktree is selected — or
              during a sync — the nested copy icon received no events at all. */}
          <div style={{ ...actionButton, display: 'flex', alignItems: 'center', gap: 6, padding: 0 }}
               onMouseEnter={e => { e.currentTarget.style.background = '#3c424e' }}
               onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
            <button onClick={doSync} disabled={!selected || busy}
                    title={syncSuccess ? result!.message : `Fetch and merge ${base} into this branch`}
                    style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', font: 'inherit',
                             color: syncSuccess ? '#89d185' : '#ddd', textAlign: 'left',
                             overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                             padding: '5px 0 5px 8px',
                             cursor: !selected || busy ? 'default' : 'pointer' }}>
              {/* The outcome replaces the label for a few seconds rather than
                  claiming its own row, so the commit box never moves. */}
              {syncing ? 'Syncing…' : syncSuccess ? `✓ ${syncSuccess}` : `⟳ Sync with ${base.replace('origin/', '')}`}
            </button>
            <button onClick={copySyncCommand} aria-label="Copy sync command"
                    title={`Copy: ${syncCommand}`}
                    style={{ flexShrink: 0, background: 'none', border: 'none', font: 'inherit',
                             color: copied ? '#89d185' : '#999', cursor: 'pointer',
                             padding: '5px 8px 5px 0' }}
                    onMouseEnter={e => { e.currentTarget.style.color = copied ? '#89d185' : '#fff' }}
                    onMouseLeave={e => { e.currentTarget.style.color = copied ? '#89d185' : '#999' }}>
              {copied ? '✓' : '⧉'}
            </button>
          </div>

          {/* gt create needs a commit message, and the box below is already the
              one the Commit button uses — so it doubles as this button's -m. */}
          <button onClick={() => setPrompt('branch')}
                  disabled={!selected || busy || !msg.trim() || total === 0}
                  title={!msg.trim()
                    ? 'Type a commit message below first'
                    : total === 0
                      ? 'No changes to put on a branch'
                      : `gt create <branch> ${stagedCount === 0 ? '-a ' : ''}-m "${msg.trim()}"`}
                  style={{ ...actionButton, textAlign: 'left',
                           color: msg.trim() && total ? '#ddd' : '#666',
                           cursor: !selected || busy || !msg.trim() || total === 0 ? 'default' : 'pointer' }}
                  onMouseEnter={e => { if (msg.trim() && total && !busy) e.currentTarget.style.background = '#3c424e' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
            {running === 'gt create' ? 'Creating…' : '⌥ gt create'}
          </button>

          {commands.map((cmd: RepoCommand) => (
            <button key={cmd.label} onClick={() => startRepoCommand(cmd)}
                    disabled={!selected || busy}
                    title={`${cmd.run}${cmd.cwd === 'repo' ? '  (in the repo root)' : ''}`}
                    style={{ ...actionButton, textAlign: 'left',
                             cursor: !selected || busy ? 'default' : 'pointer' }}
                    onMouseEnter={e => { if (!busy) e.currentTarget.style.background = '#3c424e' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
              {running === cmd.label ? `${cmd.label}…` : cmd.label}
            </button>
          ))}
        </div>

        {prompt === 'branch' && (
          <InputsPromptModal title="New branch in this stack"
                             hint={`gt create <branch> ${stagedCount === 0 ? '-a ' : ''}-m "${msg.trim()}"` +
                                   (stagedCount === 0 ? ' — nothing is staged, so all changes go on it' : '')}
                             fields={['branch']}
                             confirmLabel="Create branch"
                             onSubmit={v => doGtCreate(v.branch)}
                             onClose={() => setPrompt(undefined)} />
        )}
        {prompt && prompt !== 'branch' && (
          <InputsPromptModal title={prompt.label}
                             hint={prompt.run}
                             fields={promptVars(prompt.run)}
                             confirmLabel="Run"
                             onSubmit={values => doRepoCommand(prompt, values)}
                             onClose={() => setPrompt(undefined)} />
        )}

        <textarea placeholder="Commit message" value={msg} onChange={e => setMsg(e.target.value)}
                  rows={2} style={{ resize: 'none', background: '#2d2d2d', color: '#ddd',
                  border: '1px solid #444', borderRadius: 4, padding: 6, fontFamily: 'system-ui', fontSize: 12 }} />
        <button onClick={doCommit} disabled={committing || !msg.trim() || stagedCount === 0}
                style={{ background: stagedCount && msg.trim() ? '#0e639c' : '#3a3a3a', color: '#fff',
                         border: 'none', borderRadius: 4, padding: '6px', cursor: 'pointer', fontSize: 12 }}>
          {committing ? 'Committing…' : `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}`}
        </button>

        {pending > 0 && (
          <button onClick={doPush} disabled={pushing}
                  style={{ background: pushing ? '#3a3a3a' : '#0e639c', color: '#fff',
                           border: 'none', borderRadius: 4, padding: '6px',
                           cursor: pushing ? 'default' : 'pointer', fontSize: 12 }}>
            {pushing ? 'Pushing…' : `Push ${pending} commit${pending === 1 ? '' : 's'}`}
          </button>
        )}

        {/* Sync success is shown inline on its button; everything else needs the
            room — git's failure output is multi-line, and a push that succeeds
            takes its own button away with it. */}
        {result && !syncSuccess && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, borderRadius: 4,
                        padding: '5px 7px', fontSize: 11,
                        // Success is a one-line confirmation; failure is git's own
                        // output, so it keeps the monospace treatment and a scroll cap.
                        fontFamily: result.ok ? 'system-ui' : 'Menlo, monospace',
                        whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto',
                        color: result.ok ? '#89d185' : '#f28b82',
                        background: result.ok ? 'rgba(137, 209, 133, 0.1)' : 'rgba(242, 139, 130, 0.1)',
                        border: `1px solid ${result.ok ? 'rgba(137, 209, 133, 0.3)' : 'rgba(242, 139, 130, 0.3)'}` }}>
            <span style={{ flexShrink: 0 }}>{result.ok ? '✓' : '✕'}</span>
            <span style={{ flex: 1 }}>{result.message}</span>
            <button onClick={() => setResult(undefined)} title="Dismiss"
                    style={{ background: 'none', border: 'none', color: 'inherit', opacity: 0.6,
                             cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0, flexShrink: 0 }}>
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
