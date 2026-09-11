import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import {
  addTask, countTasks, cycleTaskState, moveTask, removeTask, renameTask, setBlocked,
  setTaskState, setTasksHeight, sortTasks, toggleTasksCollapsed, type Task
} from '@shared/tasks'
import './tasks-theme.css'

const TASK_MIME = 'application/x-wtm-task'

// A textarea rather than an input so a long title wraps instead of scrolling
// sideways in a 240px sidebar, auto-sized to its content so the box is exactly
// as tall as what's in it. Enter submits (shift+Enter breaks a line), which is
// why it can't just be a plain textarea.
function GrowingInput({ value, onChange, onSubmit, onCancel, onBlur, placeholder, autoFocus, inputRef }: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
  onBlur?: () => void
  placeholder?: string
  autoFocus?: boolean
  inputRef?: React.RefObject<HTMLTextAreaElement>
}) {
  const own = useRef<HTMLTextAreaElement>(null)
  const ref = inputRef ?? own
  // Before paint, so the box never renders at the wrong height for a frame.
  // Reset to auto first: scrollHeight only grows while the old height stands.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, ref])
  return (
    <textarea
      ref={ref}
      className="wt-input wt-task-text"
      rows={1}
      autoFocus={autoFocus}
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit() }
        else if (e.key === 'Escape') onCancel()
      }}
    />
  )
}

// Counts shown in the header, so a collapsed section still says whether
// something is blocked. Ordered by how much it wants the user.
function Counts({ tasks }: { tasks: Task[] }) {
  const c = countTasks(tasks)
  const shown: [string, number, string][] = [
    ['progress', c.progress, 'in progress'],
    ['blocked', c.blocked, 'blocked'],
    ['todo', c.open - c.progress - c.blocked, 'to do']
  ]
  const visible = shown.filter(([, n]) => n > 0)
  if (visible.length === 0) return null
  return (
    <span className="wt-tasks-counts">
      {visible.map(([key, n, label]) => (
        <span key={key} className={`wt-tasks-count wt-tasks-count-${key}`} title={`${n} ${label}`}>
          <span className="wt-tasks-count-dot" />{n}
        </span>
      ))}
    </span>
  )
}

export function TasksPanel() {
  const doc = useStore(st => st.tasks)
  const applyTasks = useStore(st => st.applyTasks)

  // One row at a time is in text-entry mode, and only ever for one field, so a
  // single pair of pieces of state covers renaming and reason-editing both.
  const [editing, setEditing] = useState<{ id: string; field: 'title' | 'reason' } | null>(null)
  const [draft, setDraft] = useState('')
  const [newTask, setNewTask] = useState('')
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; edge: 'top' | 'bottom' } | null>(null)
  const newRef = useRef<HTMLTextAreaElement>(null)
  const resizing = useRef(false)
  const [gripActive, setGripActive] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Drag the grip to trade height between the worktree list and this section.
  // Measured from the section's own bottom edge rather than from the window, so
  // it stays correct whatever else the sidebar is stacking below it.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current || !rootRef.current) return
      const bottom = rootRef.current.getBoundingClientRect().bottom
      applyTasks(setTasksHeight(useStore.getState().tasks, bottom - e.clientY))
    }
    const onUp = () => {
      if (!resizing.current) return
      resizing.current = false
      setGripActive(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [applyTasks])

  const startResize = () => {
    resizing.current = true
    setGripActive(true)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  const startEdit = (task: Task, field: 'title' | 'reason') => {
    setEditing({ id: task.id, field })
    setDraft(field === 'title' ? task.title : (task.reason ?? ''))
  }
  const commitEdit = () => {
    if (!editing) return
    applyTasks(editing.field === 'title'
      ? renameTask(doc, editing.id, draft)
      : setBlocked(doc, editing.id, draft))
    setEditing(null)
  }
  // Escape on a reason that was never written leaves the task in 'blocked' with
  // an empty reason, which reads as a bug — so cancelling an empty one sends the
  // task back to 'todo' instead.
  const cancelEdit = () => {
    if (editing?.field === 'reason') {
      const task = doc.tasks.find(t => t.id === editing.id)
      if (task && task.state === 'blocked' && !task.reason) {
        applyTasks(setTaskState(doc, task.id, 'todo'))
      }
    }
    setEditing(null)
  }

  const toggleBlocked = (task: Task) => {
    if (task.state === 'blocked') { applyTasks(setTaskState(doc, task.id, 'todo')); return }
    // Mark it blocked immediately and open the reason box: the state change is
    // the point, the reason is the detail.
    applyTasks(setBlocked(doc, task.id, task.reason ?? ''))
    startEdit({ ...task, state: 'blocked' }, 'reason')
  }

  const submitNew = () => {
    if (!newTask.trim()) return
    applyTasks(addTask(doc, newTask))
    setNewTask('')
  }

  const clearDrag = () => { setDrag(null); setOver(null) }

  const editInput = () => (
    <GrowingInput
      autoFocus
      value={draft}
      onChange={setDraft}
      onSubmit={commitEdit}
      onCancel={cancelEdit}
      onBlur={commitEdit}
    />
  )

  return (
    <div className="wt-tasks" ref={rootRef}
         style={doc.collapsed ? undefined : { height: doc.height, flexShrink: 0 }}>
      {!doc.collapsed && (
        <div className={`wt-tasks-grip${gripActive ? ' dragging' : ''}`}
             title="Drag to resize" onMouseDown={startResize} />
      )}
      <div className="wt-tasks-head" onClick={() => applyTasks(toggleTasksCollapsed(doc))}>
        <span className={`wt-tasks-caret${doc.collapsed ? '' : ' open'}`}>▸</span>
        <span className="wt-tasks-title">Tasks</span>
        <Counts tasks={doc.tasks} />
        <span className="wt-tasks-add" title="New task"
              onClick={e => {
                e.stopPropagation()
                if (doc.collapsed) applyTasks(toggleTasksCollapsed(doc))
                // The input only exists once the section is open, so focus it
                // after this render rather than in the same tick.
                setTimeout(() => newRef.current?.focus(), 0)
              }}>+</span>
      </div>

      {!doc.collapsed && (
        <div className="wt-tasks-list">
          {doc.tasks.length === 0 && (
            <div className="wt-tasks-empty">Nothing on the list. Add one below.</div>
          )}
          {sortTasks(doc.tasks).map(task => (
            <div key={task.id}
                 className={`wt-task ${task.state}${drag === task.id ? ' dragging' : ''}` +
                   `${over?.id === task.id ? ` drop-${over.edge}` : ''}`}
                 draggable={editing?.id !== task.id}
                 onDragStart={e => {
                   e.dataTransfer.setData(TASK_MIME, task.id)
                   e.dataTransfer.effectAllowed = 'move'
                   setDrag(task.id)
                 }}
                 onDragEnd={clearDrag}
                 onDragOver={e => {
                   if (!e.dataTransfer.types.includes(TASK_MIME)) return
                   e.preventDefault()
                   e.dataTransfer.dropEffect = 'move'
                   const r = e.currentTarget.getBoundingClientRect()
                   setOver({ id: task.id, edge: e.clientY - r.top > r.height / 2 ? 'bottom' : 'top' })
                 }}
                 onDrop={e => {
                   const id = e.dataTransfer.getData(TASK_MIME)
                   e.preventDefault()
                   // HTML5 DnD fires drop on the source element too; without
                   // this the task would anchor against itself and jump.
                   if (!id || id === task.id) return clearDrag()
                   const r = e.currentTarget.getBoundingClientRect()
                   applyTasks(moveTask(doc, id, task.id, e.clientY - r.top > r.height / 2))
                   clearDrag()
                 }}>
              <span className={`wt-task-mark ${task.state}`}
                    title={task.state === 'done' ? 'Reopen' : task.state === 'progress' ? 'Mark done' : 'Start'}
                    onClick={() => applyTasks(cycleTaskState(doc, task.id))} />
              <span className="wt-task-body">
                {editing?.id === task.id && editing.field === 'title'
                  ? editInput()
                  : (
                    <span className="wt-task-title"
                          onDoubleClick={() => startEdit(task, 'title')}
                          title="Double-click to edit">
                      {task.title}
                    </span>
                  )}
                {editing?.id === task.id && editing.field === 'reason'
                  ? editInput()
                  : task.state === 'blocked' && task.reason && (
                    <div className="wt-task-reason"
                         onDoubleClick={() => startEdit(task, 'reason')}
                         title="Double-click to edit">
                      {task.reason}
                    </div>
                  )}
              </span>
              <span className="wt-task-actions">
                {task.state !== 'done' && (
                  <span className="wt-task-action block"
                        title={task.state === 'blocked' ? 'Unblock' : 'Block…'}
                        onClick={() => toggleBlocked(task)}>⊘</span>
                )}
                <span className="wt-task-action remove" title="Delete task"
                      onClick={() => applyTasks(removeTask(doc, task.id))}>✕</span>
              </span>
            </div>
          ))}
          <div className="wt-task-new">
            <GrowingInput
              inputRef={newRef}
              placeholder="New task…"
              value={newTask}
              onChange={setNewTask}
              onSubmit={submitNew}
              onCancel={() => { setNewTask(''); newRef.current?.blur() }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
