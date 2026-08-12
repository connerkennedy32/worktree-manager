import { useStore } from '../state/store'
import type { Worktree } from '@shared/ipc-types'
import { deriveDot } from '@shared/agent-status'

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

function WorkingSpinner() {
  return <span className="wt-row-spinner" title="Agent working" />
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
  onShowTip: (e: React.MouseEvent) => void
  onHideTip: () => void
  // In the Hidden section the same control un-hides, so one prop covers both.
  hidden: boolean
  onToggleHidden: () => void
}

export function WorktreeRow({
  worktree: w, editing, draft, onDraftChange, onStartEdit, onCommitEdit,
  onCancelEdit, onRemove, onShowTip, onHideTip, hidden, onToggleHidden
}: WorktreeRowProps) {
  const { statuses, agentStatuses, seenAt, names, selected, select } = useStore()
  const count = statuses[w.path]?.changeCount ?? 0
  const dot = deriveDot(agentStatuses[w.path], seenAt[w.path])
  return (
    <div className={`wt-row${selected === w.path ? ' selected' : ''}${dot ? ` ${dot}` : ''}`}
         onClick={() => select(w.path)}
         onMouseEnter={onShowTip} onMouseLeave={onHideTip}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6,
                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              onDoubleClick={(e) => { e.stopPropagation(); onStartEdit() }}
              title="Double-click to rename">
          {dot === 'working' ? <WorkingSpinner /> : (w.isMain ? <MainDotIcon /> : <BranchIcon />)}
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
                       whiteSpace: 'nowrap', paddingLeft: 29 }}>
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
      </span>
    </div>
  )
}
