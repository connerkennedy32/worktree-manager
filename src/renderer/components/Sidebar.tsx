import { useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { NewWorktreeForm } from './NewWorktreeForm'
import { ConfirmModal } from './ConfirmModal'
import { disposeTerminal } from './TerminalView'
import type { Worktree } from '@shared/ipc-types'
import './sidebar-theme.css'

function MainDotIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="5" r="4" fill="currentColor" />
    </svg>
  )
}

function BranchIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" style={{ flexShrink: 0 }}>
      <circle cx="2.5" cy="2.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="2.5" cy="7.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 4.1 V7.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 4.1 C2.5 6 4 6 5.5 6" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <circle cx="7" cy="6" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function Sidebar() {
  const { worktrees, statuses, selected, select, refreshWorktrees, repos } = useStore()
  const [pending, setPending] = useState<Worktree | null>(null)
  const [pendingRepo, setPendingRepo] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout>>()

  const showTip = (e: React.MouseEvent, text: string) => {
    const x = e.clientX + 14, y = e.clientY + 12
    clearTimeout(tipTimer.current)
    tipTimer.current = setTimeout(() => setTip({ text, x, y }), 120)
  }
  const hideTip = () => { clearTimeout(tipTimer.current); setTip(null) }

  const addRepo = async () => {
    try {
      await window.api.pickRepo()
      await useStore.getState().init()
    } catch (e: any) {
      // strip Electron's "Error invoking remote method '...':" prefix
      const msg = (e?.message ?? String(e)).replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, '')
      setPickError(msg)
    }
  }

  const doDisconnectRepo = async () => {
    if (!pendingRepo) return
    setBusy(true); setError(undefined)
    try {
      const repos = await window.api.removeRepo(pendingRepo)
      useStore.setState({ repos })
      await refreshWorktrees()
      // Clear selection if the active worktree belonged to the disconnected repo.
      const stillThere = useStore.getState().worktrees.some(w => w.path === selected)
      if (!stillThere) useStore.setState({ selected: undefined })
      setPendingRepo(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally { setBusy(false) }
  }

  const pendingCount = pending ? (statuses[pending.path]?.changeCount ?? 0) : 0

  const doRemove = async () => {
    if (!pending) return
    setBusy(true); setError(undefined)
    try {
      await window.api.removeWorktree(pending.path, pendingCount > 0)
      disposeTerminal(pending.path)
      if (selected === pending.path) useStore.setState({ selected: undefined })
      await refreshWorktrees()
      setPending(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  // Worktrees are already produced repo-by-repo (see refreshWorktreeList), so
  // grouping here just visually separates what's already in repo order.
  const groups = useMemo(() => {
    return repos.map(repo => ({
      repo,
      worktrees: worktrees.filter(w => w.repoName === repo.split('/').filter(Boolean).pop()),
    }))
  }, [repos, worktrees])

  return (
    <div style={{ width: 260, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column',
                  background: 'rgba(30, 30, 30, 0.55)', color: '#ddd', fontFamily: 'system-ui', fontSize: 13 }}>
      <div style={{ padding: 8, fontWeight: 600, borderBottom: '1px solid #333',
                    display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1 }}>WORKTREES</span>
        <button className="wt-btn wt-btn-ghost" onClick={addRepo}>+ Repo</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {worktrees.length === 0 && (
          <div style={{ padding: 10, color: '#888', fontSize: 12 }}>
            No repos yet. Click "+ Repo" to add a git repository.
          </div>
        )}
        {groups.map(({ repo, worktrees: repoWorktrees }) => {
          const name = repo.split('/').filter(Boolean).pop() ?? repo
          return (
            <div key={repo}>
              <div className="wt-repo-header" title={repo}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {name}
                </span>
                <span className="wt-repo-disconnect" title="Disconnect repo"
                      onClick={() => setPendingRepo(repo)}>✕</span>
              </div>
              {repoWorktrees.map(w => {
                const count = statuses[w.path]?.changeCount ?? 0
                return (
                  <div key={w.path} className={`wt-row${selected === w.path ? ' selected' : ''}`}
                       onClick={() => select(w.path)}
                       onMouseEnter={e => showTip(e, w.path)} onMouseLeave={hideTip}>
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6,
                                     overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {w.isMain ? <MainDotIcon /> : <BranchIcon />}
                        {w.path.split('/').filter(Boolean).pop()}
                      </span>
                      <span style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis',
                                     whiteSpace: 'nowrap', paddingLeft: 16 }}>
                        {w.branch}
                      </span>
                    </div>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                      {count > 0 && <span className="wt-badge">{count}</span>}
                      {!w.isMain && <span className="wt-row-remove" title="Remove worktree" onClick={(e) => {
                        e.stopPropagation()
                        setError(undefined); setPending(w)
                      }}>✕</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {repos[0] && <NewWorktreeForm repoPath={repos[0]} />}

      {pending && (
        <ConfirmModal
          title="Remove worktree?"
          body={
            `This will remove the "${pending.branch}" worktree at:\n${pending.path}\n\nThe "${pending.branch}" branch will also be deleted.` +
            (pendingCount > 0
              ? `\n\nThis worktree has ${pendingCount} uncommitted change${pendingCount === 1 ? '' : 's'}, which will be discarded.`
              : '')
          }
          confirmLabel="Remove"
          danger
          busy={busy}
          error={error}
          onConfirm={doRemove}
          onCancel={() => { if (!busy) { setPending(null); setError(undefined) } }}
        />
      )}

      {pendingRepo && (
        <ConfirmModal
          title="Disconnect repo?"
          body={`Stop tracking this repository in the app:\n${pendingRepo}\n\nThis only removes it from the app — no files, worktrees, or branches on disk are touched.`}
          confirmLabel="Disconnect"
          busy={busy}
          error={error}
          onConfirm={doDisconnectRepo}
          onCancel={() => { if (!busy) { setPendingRepo(null); setError(undefined) } }}
        />
      )}

      {pickError && (
        <ConfirmModal
          title="Can't add that folder"
          body={pickError}
          confirmLabel="OK"
          onConfirm={() => setPickError(undefined)}
          onCancel={() => setPickError(undefined)}
        />
      )}

      {tip && (
        <div style={{ position: 'fixed', left: tip.x, top: tip.y, zIndex: 2000, pointerEvents: 'none',
                      background: '#2d2d2d', color: '#ddd', border: '1px solid #444', borderRadius: 6,
                      padding: '3px 8px', fontSize: 11, fontFamily: 'system-ui', maxWidth: 520,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      boxShadow: '0 4px 14px rgba(0,0,0,0.4)' }}>
          {tip.text}
        </div>
      )}
    </div>
  )
}
