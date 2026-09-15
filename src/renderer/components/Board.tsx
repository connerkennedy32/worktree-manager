import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { repoInitials } from '../state/board'
import { taskDigit } from '../state/task-keys'
import { ConfirmModal } from './ConfirmModal'
import { disposeTerminal } from './TerminalView'
import { deriveDot } from '@shared/agent-status'
import { removeWorktreeCommand } from '@shared/repo-commands'
import type { RepoCommand } from '@shared/ipc-types'
import { PR_STATE_LABEL, graphiteUrl } from '@shared/pr-status'
import {
  addTask, cycleTaskState, dropTask, LANE_LABEL, LANES, laneOf, removeTask,
  renameTask, setBlocked, setTaskNote, setTaskState, tasksInLane, type Lane, type Task
} from '@shared/tasks'
// The card's state box and its growing text box are the task list's, unchanged
// — this is the same vocabulary, on a bigger surface. sidebar-theme.css is
// where the shared buttons, inputs, badges and status dots live; the board is
// the only thing left that renders them.
import './sidebar-theme.css'
import './tasks-theme.css'
import './board-theme.css'

export const TASK_MIME = 'application/x-wtm-task'

// A card's worktree, resolved against what is actually on disk. A task whose
// worktree has been removed keeps the link and renders it stale — the task
// outlives the worktree, so forgetting it silently would lose information.
function useWorktreeOf(task: Task) {
  const worktrees = useStore(st => st.worktrees)
  return useMemo(
    () => (task.worktree ? worktrees.find(w => w.path === task.worktree) : undefined),
    [worktrees, task.worktree]
  )
}

export function Card({ task, lane }: { task: Task; lane: Lane }) {
  const doc = useStore(st => st.tasks)
  const applyTasks = useStore(st => st.applyTasks)
  const openTask = useStore(st => st.openTask)
  const openTaskId = useStore(st => st.openTaskId)
  const statuses = useStore(st => st.statuses)
  const agentStatuses = useStore(st => st.agentStatuses)
  const seenAt = useStore(st => st.seenAt)
  const unread = useStore(st => st.unread)
  const prStatuses = useStore(st => st.prStatuses)
  const drag = useStore(st => st.boardDrag)
  const worktree = useWorktreeOf(task)

  const [editing, setEditing] = useState<'title' | 'reason' | 'note' | null>(null)
  const [draft, setDraft] = useState('')
  const [over, setOver] = useState<'top' | 'bottom' | null>(null)
  const [pendingDelete, setPendingDelete] = useState(false)
  // Which teardown the confirm should describe. Looked up when the modal opens
  // rather than per card: the answer only matters once you are about to delete.
  const [removeCmd, setRemoveCmd] = useState<RepoCommand | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const path = worktree?.path
  const count = path ? statuses[path]?.changeCount ?? 0 : 0
  const dot = path ? deriveDot(agentStatuses[path], seenAt[path], unread[path]) : null
  // What the agent is doing, shown only while it is actually doing it: a line
  // left over from a finished turn would read as current.
  const activity = dot === 'working' || dot === 'permission'
    ? agentStatuses[path ?? '']?.activity
    : undefined
  const pr = path ? prStatuses[path] : undefined

  const startEdit = (field: 'title' | 'reason' | 'note') => {
    setEditing(field)
    setDraft(field === 'title' ? task.title
      : field === 'note' ? task.note ?? ''
        : task.reason ?? '')
  }
  const commitEdit = () => {
    if (!editing) return
    applyTasks(editing === 'title'
      ? renameTask(doc, task.id, draft)
      : editing === 'note'
        ? setTaskNote(doc, task.id, draft)
        : setBlocked(doc, task.id, draft))
    setEditing(null)
  }
  // Same rule as the sidebar list: a blocked task with no reason written reads
  // as a bug, so cancelling an empty one sends the task back to where it was.
  const cancelEdit = () => {
    if (editing === 'reason' && task.state === 'blocked' && !task.reason) {
      applyTasks(setTaskState(doc, task.id, 'todo'))
    }
    setEditing(null)
  }

  const doDelete = async () => {
    setBusy(true); setError(undefined)
    const message = await useStore.getState().deleteTask(task.id, count > 0)
    setBusy(false)
    if (message) { setError(message); return }
    if (path) disposeTerminal(path)
    setPendingDelete(false)
  }

  // Which teardown the confirm should describe. Looked up when the modal opens
  // rather than per card: the answer only matters once you are about to delete.
  const openDelete = async () => {
    setRemoveCmd(worktree
      ? removeWorktreeCommand(await window.api.listRepoCommands(worktree.path).catch(() => [])) ?? null
      : null)
    setPendingDelete(true)
  }

  const removeLabel = worktree ? 'Delete task and worktree…' : 'Delete task'
  const onRemove = () => {
    // Nothing on disk, nothing to warn about — the task list has always deleted
    // these outright, and a modal for a one-line note would be noise.
    if (!worktree) { applyTasks(removeTask(doc, task.id)); return }
    void openDelete()
  }

  return (
    <>
      <div data-card-id={task.id}
           className={`wt-card ${task.state}${dot === 'working' ? ' working' : ''}` +
             `${dot === 'permission' ? ' permission' : ''}` +
             // The agent's finished-turn green. Named `ready` rather than
             // `done` because the card already wears `done` for the task's own
             // lane state, which is a different thing entirely.
             `${dot === 'done' ? ' ready' : ''}${dot === 'failed' ? ' failed' : ''}` +
             `${openTaskId === task.id ? ' open' : ''}` +
             `${drag === task.id ? ' dragging' : ''}${over ? ` drop-${over}` : ''}`}
           draggable={!editing}
           onClick={() => { if (!editing) openTask(task.id) }}
           onDragStart={e => {
             e.dataTransfer.setData(TASK_MIME, task.id)
             e.dataTransfer.effectAllowed = 'move'
             useStore.setState({ boardDrag: task.id })
           }}
           onDragEnd={() => { useStore.setState({ boardDrag: undefined }); setOver(null) }}
           onDragOver={e => {
             if (!e.dataTransfer.types.includes(TASK_MIME)) return
             e.preventDefault()
             e.stopPropagation()
             e.dataTransfer.dropEffect = 'move'
             const r = e.currentTarget.getBoundingClientRect()
             setOver(e.clientY - r.top > r.height / 2 ? 'bottom' : 'top')
           }}
           onDragLeave={() => setOver(null)}
           onDrop={e => {
             const id = e.dataTransfer.getData(TASK_MIME)
             e.preventDefault()
             e.stopPropagation()
             const edge = over
             setOver(null)
             useStore.setState({ boardDrag: undefined })
             // A drop on the dragged card itself would anchor against itself.
             if (!id || id === task.id) return
             applyTasks(dropTask(useStore.getState().tasks, id, lane,
               { id: task.id, after: edge === 'bottom' }))
           }}>
        <div className="wt-card-top">
          <span className={`wt-task-mark ${task.state}`}
                title={task.state === 'done' ? 'Reopen' : task.state === 'progress' ? 'Mark done' : 'Start'}
                onClick={e => { e.stopPropagation(); applyTasks(cycleTaskState(doc, task.id)) }} />
          {editing === 'title' ? (
            <textarea className="wt-input wt-task-text" autoFocus rows={1} value={draft}
                      onClick={e => e.stopPropagation()}
                      onChange={e => setDraft(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={e => {
                        e.stopPropagation()
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit() }
                        else if (e.key === 'Escape') cancelEdit()
                      }} />
          ) : (
            <span className={`wt-card-title${task.fromDisk ? ' placeholder' : ''}`}
                  title={task.fromDisk ? 'Found on disk — double-click to name it' : 'Double-click to edit'}
                  onDoubleClick={e => { e.stopPropagation(); startEdit('title') }}>
              {task.title}
            </span>
          )}
          {count > 0 && <span className="wt-badge">{count}</span>}
          <span className="wt-card-actions"
                onClick={e => e.stopPropagation()}>
            <span className="wt-card-action note"
                  title={task.note ? 'Edit note' : 'Add a note…'}
                  onClick={() => startEdit('note')}>✎</span>
            {task.state !== 'done' && (
              <span className="wt-card-action block"
                    title={task.state === 'blocked' ? 'Unblock' : 'Block…'}
                    onClick={() => {
                      if (task.state === 'blocked') {
                        // Unblocking puts the card back in the lane it was
                        // blocked in, so a stuck to-do doesn't become started.
                        const back = task.blockedLane === 'todo' ? 'todo' : 'progress'
                        applyTasks(setTaskState(doc, task.id, back)); return
                      }
                      applyTasks(setBlocked(doc, task.id, task.reason ?? ''))
                      startEdit('reason')
                    }}>⊘</span>
            )}
            <span className="wt-card-action remove"
                  title={removeLabel} onClick={onRemove}>✕</span>
          </span>
        </div>

        {editing === 'note' ? (
          <textarea className="wt-input wt-task-text" autoFocus rows={1} value={draft}
                    placeholder="Context to keep on this card…"
                    onClick={e => e.stopPropagation()}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={e => {
                      e.stopPropagation()
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit() }
                      else if (e.key === 'Escape') cancelEdit()
                    }} />
        ) : task.note && (
          <div className="wt-card-note" title="Double-click to edit"
               onDoubleClick={e => { e.stopPropagation(); startEdit('note') }}>
            {task.note}
          </div>
        )}

        {editing === 'reason' ? (
          <textarea className="wt-input wt-task-text" autoFocus rows={1} value={draft}
                    placeholder="What is it waiting on?"
                    onClick={e => e.stopPropagation()}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={e => {
                      e.stopPropagation()
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit() }
                      else if (e.key === 'Escape') cancelEdit()
                    }} />
        ) : task.state === 'blocked' && task.reason && (
          <div className="wt-card-reason"
               onDoubleClick={e => { e.stopPropagation(); startEdit('reason') }}>
            {task.reason}
          </div>
        )}

        {activity && (
          <div className="wt-card-activity" title={activity}>{activity}</div>
        )}

        <div className="wt-card-meta">
          {dot === 'working' && <span className="wt-row-spinner" title="Agent working" />}
          {/* A task with no worktree says nothing here: opening it is how you
              get one. */}
          {worktree
            ? <span className="wt-chip" title={worktree.path}>⌥ {worktree.branch}</span>
            : task.worktree
              ? <span className="wt-chip stale" title={`${task.worktree} is gone`}>⌥ removed</span>
              : null}
          {/* The card doesn't grade the PR — the state lives in the tooltip and
              the chip is just the door to Graphite. */}
          {pr && pr.url && (
            <span className="wt-pr-chip"
                  title={pr.number ? `PR #${pr.number} · ${PR_STATE_LABEL[pr.state]}` : PR_STATE_LABEL[pr.state]}
                  onClick={e => { e.stopPropagation(); window.api.openUrl(graphiteUrl(pr.url!)) }}>
              {pr.number ? `PR #${pr.number}` : 'PR'}
            </span>
          )}
          {worktree && <span className="wt-card-repo">{worktree.repoName}</span>}
        </div>
      </div>

      {pendingDelete && worktree && (
        <ConfirmModal
          title="Delete task and worktree?"
          body={
            `This deletes the task "${task.title}" and removes the "${worktree.branch}" worktree at:\n${worktree.path}\n\n` +
            // The repo's own teardown decides what happens to the branch and to
            // anything else it cleans up, so don't promise git's behavior.
            (removeCmd
              ? `This repo removes worktrees with its own "${removeCmd.label}" command, which runs instead of git.`
              : `The "${worktree.branch}" branch will also be deleted.`) +
            (count > 0
              ? `\n\nThis worktree has ${count} uncommitted change${count === 1 ? '' : 's'}, which will be discarded.`
              : '')
          }
          confirmLabel="Delete both"
          danger
          busy={busy}
          error={error}
          onConfirm={doDelete}
          onCancel={() => { if (!busy) { setPendingDelete(false); setError(undefined) } }}
        />
      )}
    </>
  )
}

// The box at the bottom of To do. New tasks start there with no worktree —
// getting one is a decision you make by opening the task, not by typing. What
// you do pick here is the repo, which is what a worktree would be created in;
// it sticks, because a run of tasks is nearly always about the same repo.
export function NewTask() {
  const doc = useStore(st => st.tasks)
  const applyTasks = useStore(st => st.applyTasks)
  const repos = useStore(st => st.repos)
  const repo = useStore(st => st.newTaskRepo)
  const setRepo = useStore(st => st.setNewTaskRepo)
  const nonce = useStore(st => st.newTaskNonce)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState('')
  // Closed until asked for: the box sat at the foot of the lane whether or not
  // there was a task to write, and an empty input reads as something unfinished.
  const [open, setOpen] = useState(false)
  // Cmd+C (with nothing to copy) and the menu both ask for this box by bumping
  // the nonce. Skipped on first render, which would open it at launch.
  useEffect(() => { if (nonce !== 0) setOpen(true) }, [nonce])
  // Focus on open — including when the nonce opens it, which is the only way in
  // from the keyboard. The ref is null until the textarea is actually mounted,
  // so this cannot live in the handler that sets `open`.
  useEffect(() => { if (open) ref.current?.focus() }, [open, nonce])
  // Grow to fit, like the list's box: a long title wraps rather than scrolling.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  const close = () => { setValue(''); setOpen(false) }

  if (!open) {
    return (
      <button type="button" className="wt-card-add" onClick={() => setOpen(true)}
              title="New task">
        <span className="wt-card-add-sign">+</span>
      </button>
    )
  }

  return (
    <div className="wt-card-new">
      <textarea ref={ref} className="wt-input wt-task-text" rows={1} placeholder="New task…"
                value={value}
                onChange={e => setValue(e.target.value)}
                // Clicking away from an empty box is the same "never mind" that
                // Escape is. A box with something typed in it stays, so a stray
                // click can't lose what you wrote.
                onBlur={() => { if (!value.trim()) close() }}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (!value.trim()) return
                    applyTasks(addTask(doc, value, Date.now(), repo || undefined))
                    // Cleared but still open: tasks arrive in runs, and typing
                    // the next one should not cost another click.
                    setValue('')
                  } else if (e.key === 'Escape') close()
                }} />
      {repos.length > 0 && (
        <select className="wt-input wt-card-repo-select" value={repo}
                onChange={e => setRepo(e.target.value)}
                title="Which repo a worktree for this task would be created in">
          {repos.map(r => (
            <option key={r} value={r}>{r.split('/').filter(Boolean).pop()}</option>
          ))}
          <option value="">no repo</option>
        </select>
      )}
    </div>
  )
}

// Cards move when work starts or finishes, and a card that teleports is a card
// you lose track of. FLIP: measure where every card was, let React put them
// where they now belong, then animate each one from its old position to its new
// one — no layout thrash, since the transform is all that animates.
//
// Keyed on a signature of ids and lanes rather than the document, so typing in
// a title or a status dot changing doesn't replay the whole board.
export function useCardFlip(signature: string) {
  const previous = useRef(new Map<string, DOMRect>())
  useLayoutEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const next = new Map<string, DOMRect>()
    for (const node of document.querySelectorAll<HTMLElement>('[data-card-id]')) {
      const id = node.dataset.cardId
      if (!id) continue
      const rect = node.getBoundingClientRect()
      next.set(id, rect)
      const before = previous.current.get(id)
      // A card that wasn't there a moment ago has nowhere to travel from: it
      // fades in on its own (see .wt-card in the stylesheet) instead.
      if (!before || reduce) continue
      const dx = before.left - rect.left
      const dy = before.top - rect.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        // Long enough to follow across a column, short enough not to be in the
        // way; eased out hard so it settles rather than drifting.
        { duration: 260, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)' }
      )
    }
    previous.current = next
  }, [signature])
}

// Cmd+<number> cycles a card — the shortcut the task list had, kept because it
// works from inside a terminal. The numbers follow board order (To do, then In
// progress, then Done), which is what the user is looking at.
export function useTaskKeys(): void {
  useEffect(() => {
    const isMac = navigator.platform.startsWith('Mac')
    const onKeyDown = (e: KeyboardEvent) => {
      const n = taskDigit(e, isMac)
      if (n === null) return
      const task = boardOrder(useStore.getState().tasks)[n - 1]
      if (!task) return
      e.preventDefault()
      useStore.getState().applyTasks(cycleTaskState(useStore.getState().tasks, task.id))
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

// Cards in the order the board draws them, which is the order the numbers mean.
export function boardOrder(doc: ReturnType<typeof useStore.getState>['tasks']): Task[] {
  return LANES.flatMap(lane => tasksInLane(doc, lane))
}

function LaneColumn({ lane, tasks }: { lane: Lane; tasks: Task[] }) {
  const applyTasks = useStore(st => st.applyTasks)
  const [over, setOver] = useState(false)

  return (
    <div className={`wt-lane wt-lane-${lane}${over ? ' over' : ''}`}
         onDragOver={e => {
           if (!e.dataTransfer.types.includes(TASK_MIME)) return
           e.preventDefault()
           e.dataTransfer.dropEffect = 'move'
           setOver(true)
         }}
         onDragLeave={() => setOver(false)}
         onDrop={e => {
           const id = e.dataTransfer.getData(TASK_MIME)
           e.preventDefault()
           setOver(false)
           useStore.setState({ boardDrag: undefined })
           if (!id) return
           // Dropped on the lane rather than on a card: land at the end, which
           // is where the eye expects a card released under the last one.
           const last = tasks.filter(t => t.id !== id).at(-1)
           applyTasks(dropTask(useStore.getState().tasks, id, lane,
             last ? { id: last.id, after: true } : undefined))
         }}>
      <div className="wt-lane-head">
        <span className="wt-lane-dot" />
        <span className="wt-lane-name">{LANE_LABEL[lane]}</span>
        <span className="wt-lane-count">{tasks.length}</span>
      </div>
      <div className="wt-lane-body">
        {tasks.length === 0 && (
          <div className="wt-lane-empty">
            {lane === 'todo' ? 'Nothing waiting. Add one below.' : 'Drag a task here.'}
          </div>
        )}
        {tasks.map(t => <Card key={t.id} task={t} lane={lane} />)}
        {lane === 'todo' && <NewTask />}
      </div>
    </div>
  )
}

// The repo rail: one square per connected repo's main checkout, down the left
// edge of the board. Repo roots are not tasks — there is nothing to finish in
// one — so they are not cards; but they are still the place you stand to run a
// build, a rebase or `gt ls`, so they need a door that is always on screen.
// The square carries the same agent dot and change count a card does, because
// an agent left working in a root is exactly as easy to forget.
export function RepoRail() {
  const worktrees = useStore(st => st.worktrees)
  const statuses = useStore(st => st.statuses)
  const agentStatuses = useStore(st => st.agentStatuses)
  const seenAt = useStore(st => st.seenAt)
  const unread = useStore(st => st.unread)
  const selected = useStore(st => st.selected)
  const openTaskId = useStore(st => st.openTaskId)
  const openRepoRoot = useStore(st => st.openRepoRoot)
  const prRefreshing = useStore(st => st.prRefreshing)
  const prError = useStore(st => st.prError)
  const refreshPrStatuses = useStore(st => st.refreshPrStatuses)

  const roots = worktrees.filter(w => w.isMain)
  // Nothing connected yet: the rail would be an empty gutter, and the Repos
  // menu is what the user needs instead.
  if (roots.length === 0) return null

  return (
    <div className="wt-rail">
      {roots.map(w => {
        const dot = deriveDot(agentStatuses[w.path], seenAt[w.path], unread[w.path])
        const count = statuses[w.path]?.changeCount ?? 0
        // A root is open only when it is selected with no task over it: a task
        // in that repo selects its own worktree, not the root.
        const open = selected === w.path && !openTaskId
        return (
          <button key={w.path} type="button"
                  className={`wt-rail-repo${open ? ' open' : ''}${dot ? ` ${dot === 'done' ? 'ready' : dot}` : ''}`}
                  title={`${w.repoName} · ${w.branch}${count ? ` · ${count} changed` : ''}`}
                  onClick={() => openRepoRoot(w.path)}>
            {repoInitials(w.repoName)}
            {dot && <span className={`wt-rail-pip ${dot === 'done' ? 'ready' : dot}`} />}
            {count > 0 && <span className="wt-rail-count">{count > 99 ? '99+' : count}</span>}
          </button>
        )
      })}
      {/* PR state is fetched by shelling out to `gh`, so it is never live: this
          is how you ask for it. Tucked to the bottom of the rail because it is
          the one control here that isn't a door into a repo. */}
      <button type="button"
              className={`wt-rail-refresh${prRefreshing ? ' busy' : ''}`}
              disabled={prRefreshing}
              title={prError
                ? `Refresh PR status — last attempt failed: ${prError}`
                : prRefreshing ? 'Refreshing PR status…' : 'Refresh PR status'}
              onClick={() => refreshPrStatuses()}>
        ⟳
        {prError && !prRefreshing && <span className="wt-rail-pip failed" />}
      </button>
    </div>
  )
}

export function Board() {
  useTaskKeys()
  const doc = useStore(st => st.tasks)
  useCardFlip(doc.tasks.map(t => `${t.id}:${laneOf(t)}`).join(','))
  return (
    <div className="wt-board">
      <RepoRail />
      {LANES.map(lane => (
        <LaneColumn key={lane} lane={lane} tasks={tasksInLane(doc, lane)} />
      ))}
    </div>
  )
}
