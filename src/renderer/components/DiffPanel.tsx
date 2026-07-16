import { useEffect, useState } from 'react'
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

  const doCommit = async () => {
    if (!selected || !msg.trim()) return
    setCommitting(true)
    try {
      await window.api.commit({ worktreePath: selected, message: msg.trim() })
      setMsg('')
      await refreshStatus(selected)
    } finally { setCommitting(false) }
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
      {/* Staging an already-committed file is meaningless. */}
      {!row.committed && (
        <button onClick={e => { e.stopPropagation(); stageRow(row) }}
                title={row.staged ? 'Unstage' : 'Stage'}
                style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                         fontSize: 15, lineHeight: 1, padding: '0 2px', width: 18 }}
                onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                onMouseLeave={e => (e.currentTarget.style.color = '#999')}>
          {row.staged ? '−' : '+'}
        </button>
      )}
    </div>
  )

  const renderSection = (id: SectionId, label: string, sectionRows: Row[]) => {
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
        {renderSection('unstaged', 'Unstaged', unstagedRows)}
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
      </div>
    </div>
  )
}
