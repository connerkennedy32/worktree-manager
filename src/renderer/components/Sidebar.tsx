import { useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { ConfirmModal } from './ConfirmModal'
import { disposeTerminal } from './TerminalView'
import type { Worktree } from '@shared/ipc-types'
import { WorktreeRow } from './WorktreeRow'
import {
  addGroup, deleteGroup, deriveSections, moveTo, newGroupId, purgePaths, renameGroup, reorderGroup,
  repoLabel, toggleGroupCollapsed, toggleHiddenCollapsed, type Anchor, type DropTarget
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
      // Capture before the refresh: once the repo is gone its worktrees vanish
      // from state, and we'd have nothing left to match layout entries against.
      const name = repoLabel(pendingRepo)
      const gone = useStore.getState().worktrees.filter(w => w.repoName === name).map(w => w.path)
      const repos = await window.api.removeRepo(pendingRepo)
      useStore.setState({ repos })
      // These worktrees are gone from the app for good, so really forget them —
      // unlike a missing worktree, which render-time filtering handles.
      applyLayout(purgePaths(useStore.getState().layout, gone))
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

  // Native HTML5 DnD. `drag` is what's being dragged; `over` is where the
  // insertion indicator currently draws. Both are cleared on drop or dragend.
  const [drag, setDrag] = useState<{ kind: 'path'; path: string } | { kind: 'group'; id: string } | null>(null)
  const [over, setOver] = useState<
    { kind: 'row'; path: string; edge: 'top' | 'bottom' } |
    { kind: 'section'; key: string } |
    { kind: 'groupHeader'; id: string } | null
  >(null)

  const clearDrag = () => { setDrag(null); setOver(null) }

  const PATH_MIME = 'application/x-wtm-path'
  const GROUP_MIME = 'application/x-wtm-group'

  // Where a row would land: the target section, plus an anchor within it.
  const dropRow = (path: string, target: DropTarget, anchor?: Anchor) => {
    applyLayout(moveTo(layout, path, target, anchor))
    clearDrag()
  }

  const sectionDropProps = (key: string, target: DropTarget) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(PATH_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOver({ kind: 'section', key })
    },
    onDrop: (e: React.DragEvent) => {
      const path = e.dataTransfer.getData(PATH_MIME)
      if (!path) return
      e.preventDefault()
      // No anchor: a drop on the section itself appends.
      dropRow(path, target)
    }
  })

  const renderRows = (list: Worktree[], isHidden: boolean, target: DropTarget) =>
    list.map(w => (
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
      dragging={drag?.kind === 'path' && drag.path === w.path}
      dropEdge={over?.kind === 'row' && over.path === w.path ? over.edge : null}
      onDragStart={e => {
        e.dataTransfer.setData(PATH_MIME, w.path)
        e.dataTransfer.effectAllowed = 'move'
        setDrag({ kind: 'path', path: w.path })
      }}
      onDragEnd={clearDrag}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes(PATH_MIME)) return
        e.preventDefault()
        // Stop the section wrapper's onDragOver from also firing and
        // clobbering this row's indicator with its own drop-into highlight.
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        // Halfway down the row flips the indicator to the bottom edge, so the
        // line always sits at the boundary the drop will actually use.
        const r = e.currentTarget.getBoundingClientRect()
        const edge = e.clientY - r.top > r.height / 2 ? 'bottom' : 'top'
        setOver({ kind: 'row', path: w.path, edge })
      }}
      onDrop={e => {
        const path = e.dataTransfer.getData(PATH_MIME)
        e.preventDefault(); e.stopPropagation()
        // HTML5 DnD fires drop on the source element too. Without this guard,
        // anchoring on w.path would resolve against an array that no longer
        // contains it (detach already removed it), fall back to "end", and
        // bump the row to the bottom of its section instead of leaving it put.
        if (!path || path === w.path) return clearDrag()
        const r = e.currentTarget.getBoundingClientRect()
        const after = e.clientY - r.top > r.height / 2
        // Anchor on this row's own path — a real entry in the target's raw
        // paths array — rather than a rendered-list index, so the drop lands
        // exactly where the insertion line is drawn even with a ghost path
        // elsewhere in the section.
        dropRow(path, target, { kind: after ? 'after' : 'before', path: w.path })
      }}
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
              <div key={`g:${section.id}`} {...sectionDropProps(`g:${section.id}`, { kind: 'group', id: section.id })}>
                <div onClick={() => applyLayout(toggleGroupCollapsed(layout, section.id))}
                     draggable={editingGroup !== section.id}
                     onDragStart={e => {
                       e.dataTransfer.setData(GROUP_MIME, section.id)
                       e.dataTransfer.effectAllowed = 'move'
                       setDrag({ kind: 'group', id: section.id })
                     }}
                     onDragEnd={clearDrag}
                     onDragOver={e => {
                       if (!e.dataTransfer.types.includes(GROUP_MIME)) return
                       e.preventDefault()
                       setOver({ kind: 'groupHeader', id: section.id })
                     }}
                     onDrop={e => {
                       const id = e.dataTransfer.getData(GROUP_MIME)
                       e.preventDefault(); e.stopPropagation()
                       if (!id || id === section.id) return clearDrag()
                       // Drop lands the dragged group immediately above this one,
                       // regardless of which direction it was dragged from.
                       applyLayout(reorderGroup(layout, id, section.id))
                       clearDrag()
                     }}
                     className={`wt-group-header${
                       over?.kind === 'groupHeader' && over.id === section.id ? ' drop-above' : ''}${
                       over?.kind === 'section' && over.key === `g:${section.id}` ? ' drop-into' : ''}`}>
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
                {!section.collapsed && renderRows(section.worktrees, false, { kind: 'group', id: section.id })}
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
              <div key={`r:${section.repo}`} {...sectionDropProps(`r:${section.repo}`, { kind: 'repo' })}>
                <div className={`wt-repo-header${
                       over?.kind === 'section' && over.key === `r:${section.repo}` ? ' drop-into' : ''}`}
                     title={section.repo}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                                 whiteSpace: 'nowrap' }}>
                    {section.name}
                  </span>
                  <span className="wt-repo-disconnect" title="Disconnect repo"
                        onClick={() => setPendingRepo(section.repo)}>✕</span>
                </div>
                {renderRows(section.worktrees, false, { kind: 'repo' })}
              </div>
            )
          }
          // Hidden always renders its header, even when empty, so it's a stable
          // drop target — and collapsed by default so it stays out of the way.
          return (
            <div key="hidden" {...sectionDropProps('hidden', { kind: 'hidden' })}>
              <div className={`wt-group-header${
                     over?.kind === 'section' && over.key === 'hidden' ? ' drop-into' : ''}`}
                   onClick={() => applyLayout(toggleHiddenCollapsed(layout))}>
                <span className={`wt-group-caret${section.collapsed ? '' : ' open'}`}>▸</span>
                <span style={{ flex: 1 }}>Hidden</span>
                <span className="wt-group-count">{section.worktrees.length}</span>
              </div>
              {!section.collapsed && renderRows(section.worktrees, true, { kind: 'hidden' })}
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
