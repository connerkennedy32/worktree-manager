import { useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { ConfirmModal } from './ConfirmModal'
import { disposeTerminal } from './TerminalView'
import type { Worktree } from '@shared/ipc-types'
import { WorktreeRow } from './WorktreeRow'
import {
  addGroup, deleteGroup, deriveSections, moveTo, newGroupId, renameGroup,
  toggleGroupCollapsed, toggleHiddenCollapsed
} from './sidebar-layout'
import './sidebar-theme.css'

export function Sidebar() {
  const { worktrees, statuses, names, rename, selected, select, refreshWorktrees, repos } = useStore()
  const [pending, setPending] = useState<Worktree | null>(null)
  const [pendingRepo, setPendingRepo] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout>>()
  // Inline tab rename: the path being edited, plus the draft text.
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const startEdit = (w: Worktree) => {
    setEditingPath(w.path)
    setDraft(names[w.path] ?? (w.path.split('/').filter(Boolean).pop() ?? ''))
  }
  const commitEdit = () => {
    if (editingPath) rename(editingPath, draft)
    setEditingPath(null)
  }

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

  const { layout, applyLayout } = useStore()
  const sections = useMemo(
    () => deriveSections(layout, worktrees, repos), [layout, worktrees, repos]
  )
  // Which group header is being renamed, and its draft. Kept separate from the
  // row rename state above so editing a group can't cancel a row edit.
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')

  const createGroup = () => {
    const id = newGroupId(layout)
    applyLayout(addGroup(layout, id))
    setEditingGroup(id)
    setGroupDraft('New group')
  }
  const commitGroupEdit = () => {
    if (editingGroup) applyLayout(renameGroup(layout, editingGroup, groupDraft))
    setEditingGroup(null)
  }

  const renderRows = (list: Worktree[], isHidden: boolean) => list.map(w => (
    <WorktreeRow
      key={w.path}
      worktree={w}
      editing={editingPath === w.path}
      draft={draft}
      onDraftChange={setDraft}
      onStartEdit={() => startEdit(w)}
      onCommitEdit={commitEdit}
      onCancelEdit={() => setEditingPath(null)}
      onRemove={() => { setError(undefined); setPending(w) }}
      onShowTip={e => showTip(e, w.path)}
      onHideTip={hideTip}
      hidden={isHidden}
      onToggleHidden={() =>
        applyLayout(moveTo(layout, w.path, { kind: isHidden ? 'repo' : 'hidden' }))}
    />
  ))

  return (
    <div style={{ width: 260, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column',
                  background: 'rgba(30, 30, 30, 0.55)', color: '#ddd', fontFamily: 'system-ui', fontSize: 13 }}>
      <div style={{ padding: 8, fontWeight: 600, borderBottom: '1px solid #333',
                    display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1 }}>WORKTREES</span>
        <button className="wt-btn wt-btn-ghost" onClick={createGroup}>+ Group</button>
        <button className="wt-btn wt-btn-ghost" onClick={addRepo}>+ Repo</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {worktrees.length === 0 && (
          <div style={{ padding: 10, color: '#888', fontSize: 12 }}>
            No repos yet. Click "+ Repo" to add a git repository.
          </div>
        )}
        {sections.map(section => {
          if (section.kind === 'group') {
            return (
              <div key={`g:${section.id}`}>
                <div className="wt-group-header"
                     onClick={() => applyLayout(toggleGroupCollapsed(layout, section.id))}>
                  <span className={`wt-group-caret${section.collapsed ? '' : ' open'}`}>▸</span>
                  {editingGroup === section.id ? (
                    <input className="wt-input" autoFocus value={groupDraft}
                           onChange={e => setGroupDraft(e.target.value)}
                           onClick={e => e.stopPropagation()}
                           onBlur={commitGroupEdit}
                           onKeyDown={e => {
                             e.stopPropagation()
                             if (e.key === 'Enter') commitGroupEdit()
                             else if (e.key === 'Escape') setEditingGroup(null)
                           }}
                           style={{ flex: 1, minWidth: 0 }} />
                  ) : (
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                                   whiteSpace: 'nowrap' }}
                          onDoubleClick={e => {
                            e.stopPropagation()
                            setEditingGroup(section.id); setGroupDraft(section.name)
                          }}
                          title="Double-click to rename">
                      {section.name}
                    </span>
                  )}
                  <span className="wt-group-count">{section.worktrees.length}</span>
                  <span className="wt-group-delete" title="Delete group"
                        onClick={e => { e.stopPropagation(); applyLayout(deleteGroup(layout, section.id)) }}>
                    ✕
                  </span>
                </div>
                {!section.collapsed && renderRows(section.worktrees, false)}
                {!section.collapsed && section.worktrees.length === 0 && (
                  <div style={{ padding: '6px 10px 8px 24px', color: '#777', fontSize: 11 }}>
                    Drag worktrees here
                  </div>
                )}
              </div>
            )
          }
          if (section.kind === 'repo') {
            return (
              <div key={`r:${section.repo}`}>
                <div className="wt-repo-header" title={section.repo}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                                 whiteSpace: 'nowrap' }}>
                    {section.name}
                  </span>
                  <span className="wt-repo-disconnect" title="Disconnect repo"
                        onClick={() => setPendingRepo(section.repo)}>✕</span>
                </div>
                {renderRows(section.worktrees, false)}
              </div>
            )
          }
          // Hidden always renders its header, even when empty, so it's a stable
          // drop target — and collapsed by default so it stays out of the way.
          return (
            <div key="hidden">
              <div className="wt-group-header" onClick={() => applyLayout(toggleHiddenCollapsed(layout))}>
                <span className={`wt-group-caret${section.collapsed ? '' : ' open'}`}>▸</span>
                <span style={{ flex: 1 }}>Hidden</span>
                <span className="wt-group-count">{section.worktrees.length}</span>
              </div>
              {!section.collapsed && renderRows(section.worktrees, true)}
            </div>
          )
        })}
      </div>

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
