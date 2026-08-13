import { useStore } from '../state/store'
import type { Worktree } from '@shared/ipc-types'
import { deriveDot } from '@shared/agent-status'
import { PR_STATE_LABEL } from '@shared/pr-status'

function WorkingSpinner() {
  return <span className="wt-row-spinner" title="Agent working" />
}

function PrDot({ path }: { path: string }) {
  const pr = useStore(st => st.prStatuses[path])
  if (!pr || pr.state === 'none') return null
  const label = pr.number ? `PR #${pr.number} · ${PR_STATE_LABEL[pr.state]}` : PR_STATE_LABEL[pr.state]
  return (
    <span className={`wt-pr-dot wt-pr-${pr.state}${pr.url ? ' wt-pr-link' : ''}`}
          title={label}
          onClick={e => { e.stopPropagation(); if (pr.url) window.api.openUrl(pr.url) }} />
  )
}

export interface WorktreeRowProps {
  worktree: Worktree
  editing: boolean
  draft: string
  onDraftChange: (v: string) => void
  onStartEdit: () => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onRemove: () => void
  // Set only for a main checkout that resolves to a repo path (see
  // Sidebar.tsx's repoPathFor); undefined means don't render the control at
  // all rather than guess. Disconnecting is non-destructive (nothing on disk
  // changes), so it's a separate control from onRemove — never the same ✕.
  onDisconnect?: () => void
  onShowTip: (e: React.MouseEvent) => void
  onHideTip: () => void
  // In the Hidden section the same control un-hides, so one prop covers both.
  hidden: boolean
  onToggleHidden: () => void
  dragging: boolean
  // Which edge to draw the insertion line on while a drag hovers this row.
  dropEdge: 'top' | 'bottom' | null
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

export function WorktreeRow({
  worktree: w, editing, draft, onDraftChange, onStartEdit, onCommitEdit,
  onCancelEdit, onRemove, onDisconnect, onShowTip, onHideTip, hidden, onToggleHidden,
  dragging, dropEdge, onDragStart, onDragEnd, onDragOver, onDrop
}: WorktreeRowProps) {
  const { statuses, agentStatuses, seenAt, names, selected, select } = useStore()
  const count = statuses[w.path]?.changeCount ?? 0
  const dot = deriveDot(agentStatuses[w.path], seenAt[w.path])
  return (
    <div className={`wt-row${selected === w.path ? ' selected' : ''}${dot ? ` ${dot}` : ''}` +
                     `${dragging ? ' dragging' : ''}${dropEdge ? ` drop-${dropEdge}` : ''}`}
         draggable={!editing}
         onDragStart={onDragStart}
         onDragEnd={onDragEnd}
         onDragOver={onDragOver}
         onDrop={onDrop}
         onClick={() => select(w.path)}
         onMouseEnter={onShowTip} onMouseLeave={onHideTip}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6,
                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              onDoubleClick={(e) => { e.stopPropagation(); onStartEdit() }}
              title="Double-click to rename">
          {dot === 'working' && <WorkingSpinner />}
          <PrDot path={w.path} />
          {editing ? (
            <input
              className="wt-input"
              autoFocus
              value={draft}
              onChange={e => onDraftChange(e.target.value)}
              onClick={e => e.stopPropagation()}
              onBlur={onCommitEdit}
              onKeyDown={e => {
                e.stopPropagation()
                if (e.key === 'Enter') onCommitEdit()
                else if (e.key === 'Escape') onCancelEdit()
              }}
              style={{ flex: 1, minWidth: 0 }}
            />
          ) : (
            names[w.path] ?? w.path.split('/').filter(Boolean).pop()
          )}
        </span>
        <span style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis',
                       whiteSpace: 'nowrap' }}>
          {w.branch}
        </span>
      </div>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        {count > 0 && <span className="wt-badge">{count}</span>}
        <span className="wt-row-hide" title={hidden ? 'Show in sidebar' : 'Hide'}
              onClick={e => { e.stopPropagation(); onToggleHidden() }}>
          {hidden ? '◇' : '◆'}
        </span>
        {!w.isMain && <span className="wt-row-remove" title="Remove worktree" onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}>✕</span>}
        {w.isMain && onDisconnect && <span className="wt-row-remove" title="Disconnect repo" onClick={(e) => {
          e.stopPropagation()
          onDisconnect()
        }}>✕</span>}
      </span>
    </div>
  )
}
