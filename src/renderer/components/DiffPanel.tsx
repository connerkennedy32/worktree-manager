import { useEffect, useMemo, useState } from 'react'
import { parseDiff, Diff, Hunk } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './diff-theme.css'
import { useStore } from '../state/store'

interface Row {
  key: string
  path: string
  staged: boolean
  untracked: boolean
  code: string // status letter: M A D R ? etc.
}

const codeColor = (c: string) =>
  c === 'A' || c === '?' ? '#6a9955' : c === 'D' ? '#c94a4a' : '#c9a26a'

export function DiffPanel({ collapsed, onToggle, width = 460 }:
  { collapsed: boolean; onToggle: () => void; width?: number }) {
  const selected = useStore(s => s.selected)
  const refreshStatus = useStore(s => s.refreshStatus)
  const status = useStore(s => (selected ? s.statuses[selected] : undefined))
  const worktrees = useStore(s => s.worktrees)
  const branch = worktrees.find(w => w.path === selected)?.branch

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [patches, setPatches] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const [committing, setCommitting] = useState(false)

  // Keep status fresh when the worktree is selected.
  useEffect(() => { if (selected) refreshStatus(selected) }, [selected])

  // Build the file list cheaply from `git status` — no diffs computed here.
  const rows = useMemo<Row[]>(() => {
    if (!status) return []
    const out: Row[] = []
    for (const f of status.files) {
      const untracked = f.index === '?' && f.working === '?'
      if (untracked) {
        out.push({ key: f.path + ':u', path: f.path, staged: false, untracked: true, code: '?' })
        continue
      }
      if (f.index !== ' ' && f.index !== '?') {
        out.push({ key: f.path + ':s', path: f.path, staged: true, untracked: false, code: f.index })
      }
      if (f.working !== ' ' && f.working !== '?') {
        out.push({ key: f.path + ':w', path: f.path, staged: false, untracked: false, code: f.working })
      }
    }
    return out
  }, [status])

  const stagedCount = rows.filter(r => r.staged).length
  const total = rows.length

  const fetchPatch = async (row: Row) => {
    if (!selected || patches[row.key] !== undefined) return
    const patch = await window.api.getFileDiff({
      worktreePath: selected, path: row.path, staged: row.staged, untracked: row.untracked
    })
    setPatches(p => ({ ...p, [row.key]: patch }))
  }

  const toggle = (row: Row) => {
    setExpanded(s => {
      const n = new Set(s)
      if (n.has(row.key)) n.delete(row.key)
      else { n.add(row.key); fetchPatch(row) }
      return n
    })
  }

  const stageRow = async (row: Row) => {
    if (!selected) return
    await window.api.stagePath({ worktreePath: selected, path: row.path, unstage: row.staged })
    // Patch content for the old staged/unstaged split is now stale; drop cache.
    setPatches({})
    setExpanded(new Set())
    await refreshStatus(selected)
  }

  const doCommit = async () => {
    if (!selected || !msg.trim()) return
    setCommitting(true)
    try {
      await window.api.commit({ worktreePath: selected, message: msg.trim() })
      setMsg(''); setPatches({}); setExpanded(new Set())
      await refreshStatus(selected)
    } finally { setCommitting(false) }
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
        {selected && total === 0 && <div style={{ padding: 12, color: '#888', fontSize: 12 }}>No changes.</div>}
        {rows.map(row => {
          const open = expanded.has(row.key)
          const patch = patches[row.key]
          let parsed: any[] = []
          if (open && patch) { try { parsed = parseDiff(patch, { nearbySequences: 'zip' }) } catch { parsed = [] } }
          return (
            <div key={row.key} style={{ borderBottom: '1px solid #2a2a2a' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
                            background: 'rgba(37, 37, 38, 0.5)', fontSize: 12 }}>
                <span onClick={() => toggle(row)} style={{ cursor: 'pointer', width: 12, color: '#888' }}>
                  {open ? '▾' : '▸'}
                </span>
                <span title={row.staged ? 'staged' : 'unstaged'}
                      style={{ color: codeColor(row.code), width: 12, textAlign: 'center' }}>{row.code}</span>
                <span onClick={() => toggle(row)}
                      style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis',
                               whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}
                      title={row.path}>{row.path}</span>
                <button onClick={() => stageRow(row)} style={{ fontSize: 11 }}>
                  {row.staged ? 'Unstage' : 'Stage'}
                </button>
              </div>
              {open && (
                <div style={{ overflowX: 'auto' }}>
                  {patch === undefined && <div style={{ padding: 8, color: '#888', fontSize: 11 }}>Loading…</div>}
                  {patch !== undefined && parsed.length === 0 &&
                    <div style={{ padding: 8, color: '#888', fontSize: 11 }}>No textual diff (binary or empty).</div>}
                  {parsed.map((d: any, di: number) => (
                    <Diff key={di} viewType="unified" diffType={d.type} hunks={d.hunks}>
                      {(hunks: any[]) => hunks.map((h, hi) => <Hunk key={hi} hunk={h} />)}
                    </Diff>
                  ))}
                </div>
              )}
            </div>
          )
        })}
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
