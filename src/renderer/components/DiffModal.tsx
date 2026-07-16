import { useEffect, useMemo, useState } from 'react'
import { parseDiff, Diff, Hunk } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './diff-theme.css'
import { useStore } from '../state/store'
import { useChangedFiles, codeColor, type Row, type SectionId } from './changed-files'

type ViewType = 'unified' | 'split'

const VIEW_KEY = 'wtm.diffView'

export function DiffModal() {
  const selected = useStore(s => s.selected)
  const openDiff = useStore(s => s.openDiff)
  const setOpenDiff = useStore(s => s.setOpenDiff)
  const refreshStatus = useStore(s => s.refreshStatus)
  const worktrees = useStore(s => s.worktrees)
  const branch = worktrees.find(w => w.path === selected)?.branch

  const { stagedRows, unstagedRows, committedRows, committed } = useChangedFiles(selected)
  const [patches, setPatches] = useState<Record<string, string>>({})
  // Side-by-side by default: the modal is wide enough for it. Last choice wins after that.
  const [view, setView] = useState<ViewType>(() =>
    localStorage.getItem(VIEW_KEY) === 'unified' ? 'unified' : 'split')

  const setViewPref = (v: ViewType) => { setView(v); localStorage.setItem(VIEW_KEY, v) }

  const allRows = useMemo(
    () => [...stagedRows, ...unstagedRows, ...committedRows],
    [stagedRows, unstagedRows, committedRows])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenDiff(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpenDiff])

  // The open file vanished (committed, reverted, checked out elsewhere) — close
  // rather than show a stale diff. The length guard keeps this from firing while
  // the list is still loading. Staging is handled in stageRow, not here.
  useEffect(() => {
    if (!openDiff || allRows.length === 0) return
    if (!allRows.some(r => r.key === openDiff.key)) setOpenDiff(null)
  }, [allRows, openDiff, setOpenDiff])

  // Fetch the open file's patch. Cached by row key; cleared on stage.
  useEffect(() => {
    if (!selected || !openDiff || patches[openDiff.key] !== undefined) return
    let cancelled = false
    window.api.getFileDiff({
      worktreePath: selected,
      path: openDiff.path,
      staged: openDiff.staged,
      untracked: openDiff.untracked,
      baseRef: openDiff.committed ? committed?.baseBranch : undefined
    }).then(p => { if (!cancelled) setPatches(m => ({ ...m, [openDiff.key]: p })) })
    return () => { cancelled = true }
  }, [selected, openDiff, patches, committed])

  const stageRow = async (row: Row) => {
    if (!selected) return
    await window.api.stagePath({ worktreePath: selected, path: row.path, unstage: row.staged })
    // Patch content for the old staged/unstaged split is now stale; drop cache.
    setPatches({})
    // Staging flips the row's key suffix. Follow the file to its new side so the
    // modal stays open on what the user is reading.
    if (openDiff?.key === row.key) {
      const staged = !row.staged
      setOpenDiff({ ...row, staged, untracked: false, key: row.path + (staged ? ':s' : ':w') })
    }
    await refreshStatus(selected)
  }

  if (!openDiff) return null

  const patch = patches[openDiff.key]
  let parsed: any[] = []
  if (patch) { try { parsed = parseDiff(patch, { nearbySequences: 'zip' }) } catch { parsed = [] } }

  const renderRailRow = (row: Row) => {
    const active = row.key === openDiff.key
    return (
      <div key={row.key} onClick={() => setOpenDiff(row)}
           style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
                    cursor: 'pointer', fontSize: 12,
                    background: active ? '#37373d' : 'transparent',
                    color: active ? '#fff' : '#d4d4d4' }}>
        <span style={{ color: codeColor(row.code), width: 12, textAlign: 'center' }}>{row.code}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                       direction: 'rtl', textAlign: 'left' }} title={row.path}>{row.path}</span>
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
  }

  const renderRailSection = (id: SectionId, label: string, rows: Row[]) => {
    if (rows.length === 0) return null
    return (
      <div key={id}>
        <div style={{ padding: '5px 10px', position: 'sticky', top: 0, zIndex: 1,
                      borderTop: '1px solid #333', borderBottom: '1px solid #2a2a2a',
                      background: '#2d2d2d', fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
                      textTransform: 'uppercase', color: '#bbb', display: 'flex', gap: 6 }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <span style={{ color: '#888', fontWeight: 400 }}>{rows.length}</span>
        </div>
        {rows.map(renderRailRow)}
      </div>
    )
  }

  const viewBtn = (v: ViewType, label: string) => (
    <button onClick={() => setViewPref(v)}
            style={{ background: view === v ? '#0e639c' : 'transparent', color: view === v ? '#fff' : '#bbb',
                     border: 'none', borderRadius: 3, padding: '3px 10px', cursor: 'pointer', fontSize: 12 }}>
      {label}
    </button>
  )

  const activeRow = allRows.find(r => r.key === openDiff.key)

  return (
    <div onClick={() => setOpenDiff(null)}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()}
           style={{ background: '#2d2d2d', color: '#d4d4d4', fontFamily: 'system-ui',
                    border: '1px solid #444', borderRadius: 6, boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                    width: 'calc(100vw - 60px)', height: 'calc(100vh - 60px)',
                    display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex',
                      alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>Changes {branch ? `· ${branch}` : ''}</span>
          <span style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 2, background: '#252526', borderRadius: 4, padding: 2 }}>
            {viewBtn('unified', 'Inline')}
            {viewBtn('split', 'Side by side')}
          </div>
          <button onClick={() => setOpenDiff(null)} title="Close (Esc)"
                  style={{ background: 'none', border: 'none', color: '#ddd', cursor: 'pointer',
                           fontSize: 16, lineHeight: 1, padding: '0 4px' }}>✕</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: 260, borderRight: '1px solid #333', overflowY: 'auto', flexShrink: 0 }}>
            {renderRailSection('staged', 'Staged', stagedRows)}
            {renderRailSection('unstaged', 'Unstaged', unstagedRows)}
            {renderRailSection('committed', `Committed vs ${committed?.baseBranch ?? ''}`, committedRows)}
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '6px 12px', borderBottom: '1px solid #333', fontSize: 12,
                          display: 'flex', alignItems: 'center', gap: 8, background: '#252526' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                             whiteSpace: 'nowrap' }} title={openDiff.path}>{openDiff.path}</span>
              {activeRow && !activeRow.committed && (
                <button onClick={() => stageRow(activeRow)}
                        style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                 borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                  {activeRow.staged ? 'Unstage' : 'Stage'}
                </button>
              )}
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: '#1e1e1e' }}>
              {patch === undefined && <div style={{ padding: 12, color: '#888', fontSize: 12 }}>Loading…</div>}
              {patch !== undefined && parsed.length === 0 &&
                <div style={{ padding: 12, color: '#888', fontSize: 12 }}>No textual diff (binary or empty).</div>}
              {parsed.map((d: any, di: number) => (
                <Diff key={di} viewType={view} diffType={d.type} hunks={d.hunks}>
                  {(hunks: any[]) => hunks.map((h, hi) => <Hunk key={hi} hunk={h} />)}
                </Diff>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
