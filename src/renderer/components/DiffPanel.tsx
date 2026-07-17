import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { useChangedFiles, codeColor, type Row, type SectionId } from './changed-files'

// Diffs are not rendered here — clicking a row opens DiffModal. This panel is the
// file list, the staging surface, and the commit box.
export function DiffPanel({ collapsed, onToggle, width = 460 }:
  { collapsed: boolean; onToggle: () => void; width?: number }) {
  const selected = useStore(s => s.selected)
  const refreshStatus = useStore(s => s.refreshStatus)
  const setOpenDiff = useStore(s => s.setOpenDiff)
  const worktrees = useStore(s => s.worktrees)
  const branch = worktrees.find(w => w.path === selected)?.branch

  const { stagedRows, unstagedRows, committedRows, committed, stagedCount, total } =
    useChangedFiles(selected)

  const [msg, setMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [pending, setPending] = useState(0)
  const [pushing, setPushing] = useState(false)
  const [pushError, setPushError] = useState<string>()

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

  // An error from one worktree must not linger over another.
  useEffect(() => { setPushError(undefined) }, [selected])
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
    setPushError(undefined)
    try {
      const result = await window.api.push(selected)
      if (result.ok) await refreshStatus(selected)
      else setPushError(result.message)
    } finally { setPushing(false) }
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

        {pushError && (
          <div style={{ color: '#f28b82', fontSize: 11, whiteSpace: 'pre-wrap',
                        maxHeight: 120, overflow: 'auto', fontFamily: 'Menlo, monospace' }}>
            {pushError}
          </div>
        )}
      </div>
    </div>
  )
}
