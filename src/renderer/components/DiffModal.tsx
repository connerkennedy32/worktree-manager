import { useEffect, useMemo, useState } from 'react'
import { parseDiff, Diff, Hunk } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './diff-theme.css'
import { useStore } from '../state/store'
import { useChangedFiles, codeColor, reconcileTarget, type Row } from './changed-files'
import { languageOf, tokenizeHunks } from './diff-tokens'

type ViewType = 'unified' | 'split'

const VIEW_KEY = 'wtm.diffView'

// Split a repo-relative path for display. No separator means the whole path is the
// filename, which both of these handle via lastIndexOf's -1.
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1)
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

export function DiffModal() {
  const selected = useStore(s => s.selected)
  const openDiff = useStore(s => s.openDiff)
  const setOpenDiff = useStore(s => s.setOpenDiff)
  const refreshStatus = useStore(s => s.refreshStatus)
  const worktrees = useStore(s => s.worktrees)
  const branch = worktrees.find(w => w.path === selected)?.branch

  const { stagedRows, unstagedRows, committedRows, committed, loaded } = useChangedFiles(selected)
  const status = useStore(s => (selected ? s.statuses[selected] : undefined))
  // One entry, scoped to the worktree: row keys like "src/index.ts:w" repeat across
  // worktrees of the same repo, so a bare row key would serve one worktree's diff
  // for another's file. Refetches on every status change, so an open diff tracks
  // edits on disk instead of freezing.
  const [patch, setPatch] = useState<{ key: string; text: string } | null>(null)
  const patchKey = openDiff ? `${selected}\0${openDiff.key}` : ''
  // Side-by-side by default: the modal is wide enough for it. Last choice wins after that.
  const [view, setView] = useState<ViewType>(() =>
    localStorage.getItem(VIEW_KEY) === 'unified' ? 'unified' : 'split')

  const setViewPref = (v: ViewType) => { setView(v); localStorage.setItem(VIEW_KEY, v) }

  const allRows = useMemo(
    () => [...stagedRows, ...unstagedRows, ...committedRows],
    [stagedRows, unstagedRows, committedRows])

  useEffect(() => {
    if (!openDiff) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenDiff(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openDiff, setOpenDiff])

  // Staging changes a row's key, so follow the file rather than the key; close
  // only when it is genuinely gone. Identity compare: reconcileTarget returns the
  // same object when nothing changed, so this cannot loop.
  useEffect(() => {
    if (!openDiff || !loaded) return
    const next = reconcileTarget(openDiff, allRows)
    if (next !== openDiff) setOpenDiff(next)
  }, [allRows, openDiff, setOpenDiff, loaded])

  // Fetch the open file's patch, scoped by worktree + row key. Refetches whenever
  // status changes, so an open diff tracks edits on disk instead of freezing.
  useEffect(() => {
    if (!selected || !openDiff) return
    let cancelled = false
    window.api.getFileDiff({
      worktreePath: selected,
      path: openDiff.path,
      staged: openDiff.staged,
      untracked: openDiff.untracked,
      baseRef: openDiff.committed ? committed?.baseBranch : undefined
    }).then(text => { if (!cancelled) setPatch({ key: patchKey, text }) })
    return () => { cancelled = true }
  }, [selected, openDiff, status, committed?.baseBranch, patchKey])

  const stageRow = async (row: Row) => {
    if (!selected) return
    await window.api.stagePath({ worktreePath: selected, path: row.path, unstage: row.staged })
    await refreshStatus(selected)
  }

  // A refetch of the SAME file keeps showing the old text (no "Loading…" flicker
  // on every status tick); switching files shows "Loading…" immediately.
  const patchText = patch && patch.key === patchKey ? patch.text : undefined
  const parsed = useMemo<any[]>(() => {
    if (!patchText) return []
    try { return parseDiff(patchText, { nearbySequences: 'zip' }) } catch { return [] }
  }, [patchText])

  // getFileDiff fetches exactly one file, so the open row's path names the
  // language for every entry in `parsed`.
  const language = openDiff ? languageOf(openDiff.path) : undefined
  // Tokenizing walks every line of both sides, so it must not rerun on unrelated
  // renders — hovering a rail row, or a status tick that refetches identical
  // text. `parsed` is memoized on the patch text, which makes it a stable key.
  const tokens = useMemo(
    () => parsed.map(d => tokenizeHunks(d.hunks, language)),
    [parsed, language])

  if (!openDiff) return null

  const renderRailRow = (row: Row) => {
    const active = row.key === openDiff.key
    return (
      <div key={row.key} onClick={() => setOpenDiff(row)}
           // Hover only matters for rows you can move to; the active row already
           // owns its background.
           onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#2a2d2e' }}
           onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
           style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12,
                    // The accent bar carries the selection; it reads at a glance even
                    // against the hover tint, which a background alone did not.
                    borderLeft: `3px solid ${active ? '#4daafc' : 'transparent'}`,
                    padding: '5px 10px 5px 7px',
                    background: active ? '#094771' : 'transparent',
                    color: active ? '#fff' : '#d4d4d4',
                    fontWeight: active ? 600 : 400 }}>
        <span style={{ color: codeColor(row.code), width: 12, textAlign: 'center' }}>{row.code}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                       direction: 'rtl', textAlign: 'left' }} title={row.path}>{row.path}</span>
        {/* Staging an already-committed file is meaningless. */}
        {!row.committed && (
          <button onClick={e => { e.stopPropagation(); stageRow(row) }}
                  title={row.staged ? 'Unstage' : 'Stage'}
                  style={{ background: 'none', border: 'none', color: active ? '#cfe6ff' : '#999',
                           cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px', width: 18 }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                  onMouseLeave={e => (e.currentTarget.style.color = active ? '#cfe6ff' : '#999')}>
            {row.staged ? '−' : '+'}
          </button>
        )}
      </div>
    )
  }

  const renderRailSection = (label: string, rows: Row[]) => {
    if (rows.length === 0) return null
    return (
      <div>
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
            {renderRailSection('Staged', stagedRows)}
            {renderRailSection('Unstaged', unstagedRows)}
            {renderRailSection(`Committed vs ${committed?.baseBranch ?? ''}`, committedRows)}
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '7px 12px', borderBottom: '1px solid #333', fontSize: 13,
                          display: 'flex', alignItems: 'center', gap: 8, background: '#252526' }}>
              {/* The filename is what identifies the diff, so it gets the weight; the
                  directory is context and recedes. Ellipsis sits on the directory,
                  which is the half that's expendable when the path is long. */}
              <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline' }}
                    title={openDiff.path}>
                <span style={{ color: '#888', overflow: 'hidden', textOverflow: 'ellipsis',
                               whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>{dirOf(openDiff.path)}</span>
                <span style={{ color: '#fff', fontWeight: 600, flexShrink: 0 }}>{baseOf(openDiff.path)}</span>
                {activeRow && (
                  <span style={{ color: '#888', flexShrink: 0, marginLeft: 8, fontSize: 11 }}>
                    {activeRow.committed ? 'committed' : activeRow.staged ? 'staged' : 'unstaged'}
                  </span>
                )}
              </span>
              {activeRow && !activeRow.committed && (
                <button onClick={() => stageRow(activeRow)}
                        style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                 borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                  {activeRow.staged ? 'Unstage' : 'Stage'}
                </button>
              )}
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: '#1e1e1e' }}>
              {patchText === undefined && <div style={{ padding: 12, color: '#888', fontSize: 12 }}>Loading…</div>}
              {patchText !== undefined && parsed.length === 0 &&
                <div style={{ padding: 12, color: '#888', fontSize: 12 }}>No textual diff (binary or empty).</div>}
              {parsed.map((d: any, di: number) => (
                <Diff key={di} viewType={view} diffType={d.type} hunks={d.hunks} tokens={tokens[di]}>
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
