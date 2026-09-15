import { useEffect, useRef, useState } from 'react'
import {
  BOARD_HALF, LIST_DEFAULT_WIDTH, resolveBoardHeight, setBoardHeight, setListWidth,
  toggleLayout
} from '@shared/tasks'
import { useStore } from './state/store'
import { hasCopyableSelection, isNewTaskKey } from './state/task-keys'
import { Board } from './components/Board'
import { TaskList } from './components/TaskList'
import { StartPane } from './components/StartPane'
import { TerminalView, resetTerminal } from './components/TerminalView'
import { DiffPanel } from './components/DiffPanel'
import { DiffModal } from './components/DiffModal'
import { CommandsEditor } from './components/CommandsEditor'
import blackholeVideo from './assets/blackhole-backdrop.mp4'
import voyageImage from './assets/voyage-backdrop.jpg'

const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv']
const isVideo = (name: string) => VIDEO_EXTS.some(e => name.toLowerCase().endsWith(e))
// Built-in backdrops, keyed by the `builtin:<id>` selection value from the menu.
const BUILTINS: Record<string, { src: string; video: boolean }> = {
  'builtin:voyage': { src: voyageImage, video: false },
  'builtin:blackhole': { src: blackholeVideo, video: true }
}
// Resolve the active backdrop. '' = blank (no element). A `builtin:` value maps
// to a bundled asset; anything else is a user-added file served over wtm-bg://.
function useBackdrop() {
  const selected = useStore(s => s.selectedBackground)
  if (!selected) return null
  if (selected in BUILTINS) return BUILTINS[selected]
  return { src: `wtm-bg://bg/${encodeURIComponent(selected)}`, video: isVideo(selected) }
}

const MIN_DIFF_WIDTH = 280
const MAX_DIFF_WIDTH = 900

const backdropStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: -1,
  width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(0.5)'
}

function Backdrop() {
  const backdrop = useBackdrop()
  if (!backdrop) return null // blank
  const { src, video } = backdrop
  // key=src forces a fresh element on switch so the new source actually loads.
  return video
    ? <video key={src} src={src} autoPlay loop muted playsInline style={backdropStyle} />
    : <img key={src} src={src} style={backdropStyle} />
}

// The lower half: the open task's terminal, or the pane that offers to create
// a worktree for it. Nothing open is its own state — the board above is full of
// things to click, so this says which one it wants rather than sitting blank.
function TaskSurface() {
  const openTaskId = useStore(s => s.openTaskId)
  const selected = useStore(s => s.selected)
  const task = useStore(s => s.tasks.tasks.find(t => t.id === s.openTaskId))
  const worktrees = useStore(s => s.worktrees)
  const layout = useStore(s => s.tasks.layout)

  // A repo root, opened from the rail: no task, and none is missing — the root
  // is the thing being worked in. Checked before the empty state, which is
  // otherwise what "selected but task-less" would draw.
  const root = !openTaskId && selected ? worktrees.find(w => w.path === selected && w.isMain) : undefined
  if (root) {
    return (
      <>
        <div className="wt-crumb">
          <span className="wt-crumb-title">{root.repoName}</span>
          <span className="wt-chip">⌥ {root.branch}</span>
        </div>
        <TerminalView />
      </>
    )
  }

  if (!openTaskId || !task) {
    // "above" is only true in one of the two layouts, and a pointer to the
    // wrong side of the screen is worse than no pointer at all.
    return (
      <div className="wt-surface-empty">
        Pick a task {layout === 'list' ? 'on the left' : 'above'}, or a repo from the rail.
      </div>
    )
  }
  // A task shows a terminal only if its worktree is still on disk and is what's
  // selected; otherwise the start pane is the honest answer.
  const worktree = task.worktree ? worktrees.find(w => w.path === task.worktree) : undefined
  return (
    <>
      <div className="wt-crumb">
        <span className="wt-crumb-title">{task.title}</span>
        {worktree && <span className="wt-chip">⌥ {worktree.branch}</span>}
      </div>
      {worktree && selected ? <TerminalView /> : <StartPane task={task} />}
    </>
  )
}

// The layout the user picked. Both put the same cards next to the same
// terminal; they differ in which axis the space is split on, which is the whole
// point — a horizontal split leaves nothing usable on a short screen.
function MainArea() {
  const layout = useStore(s => s.tasks.layout)
  return layout === 'list' ? <ListLayout /> : <BoardLayout />
}

// Cards in a column on the left, terminal filling the full height on the right.
// The terminal is the thing that needs the vertical room, so it is the side
// that gets all of it.
function ListLayout() {
  const stored = useStore(s => s.tasks.listWidth)
  const applyTasks = useStore(s => s.applyTasks)
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const left = rootRef.current?.getBoundingClientRect().left ?? 0
      applyTasks(setListWidth(useStore.getState().tasks, e.clientX - left))
    }
    const onUp = () => {
      setDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragging, applyTasks])

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ width: stored, flexShrink: 0, display: 'flex', minWidth: 0 }}>
        <TaskList />
      </div>
      <div className={`wt-split-grip vertical${dragging ? ' dragging' : ''}`}
           title="Drag to resize · double-click to reset"
           onMouseDown={() => {
             setDragging(true)
             document.body.style.cursor = 'col-resize'
             document.body.style.userSelect = 'none'
           }}
           onDoubleClick={() => applyTasks(setListWidth(useStore.getState().tasks, LIST_DEFAULT_WIDTH))} />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <TaskSurface />
      </div>
    </div>
  )
}

// Board on top, terminal underneath, with a grip between them. Both are on
// screen at once: the board is what you steer by, and watching an agent work
// while you re-plan the next card is the whole point of the split.
function BoardLayout() {
  const stored = useStore(s => s.tasks.height)
  const applyTasks = useStore(s => s.applyTasks)
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight)
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // An unset height means half the window, so the split has to follow a resize
  // rather than being measured once at mount.
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Measured from the split's own top edge rather than from the window, so it
  // stays correct whatever else the layout stacks above it.
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const top = rootRef.current?.getBoundingClientRect().top ?? 0
      applyTasks(setBoardHeight(useStore.getState().tasks, e.clientY - top))
    }
    const onUp = () => {
      setDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragging, applyTasks])

  const height = resolveBoardHeight(stored, windowHeight)

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height, flexShrink: 0, display: 'flex', minHeight: 0 }}>
        <Board />
      </div>
      <div className={`wt-split-grip${dragging ? ' dragging' : ''}`}
           title="Drag to resize · double-click to split evenly"
           onMouseDown={() => {
             setDragging(true)
             document.body.style.cursor = 'row-resize'
             document.body.style.userSelect = 'none'
           }}
           onDoubleClick={() => applyTasks(setBoardHeight(useStore.getState().tasks, BOARD_HALF))} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <TaskSurface />
      </div>
    </div>
  )
}

export function App() {
  const init = useStore(s => s.init)
  const selected = useStore(s => s.selected)
  const [diffCollapsed, setDiffCollapsed] = useState(false)
  const [editingCommands, setEditingCommands] = useState(false)
  const [diffWidth, setDiffWidth] = useState(MIN_DIFF_WIDTH)
  const dragging = useRef(false)

  // Resolve which repo a new worktree should be created in: the selected
  // worktree's repo root (its main worktree), else the first connected repo.

  useEffect(() => { init() }, [init])

  // Commands › Edit Repo Commands… (Cmd+Shift+K) opens the same editor the
  // changes panel does, so it is reachable without a worktree selected.
  useEffect(() => window.api.onMenuEditCommands(() => setEditingCommands(true)), [])

  // Reset the active terminal when the Terminal › Reset menu item is chosen.
  useEffect(() => {
    return window.api.onMenuResetTerminal(() => {
      const sel = useStore.getState().selected
      if (sel) resetTerminal(sel)
    })
  }, [])

  // Step through worktrees from the Worktree menu (Cmd+Up / Cmd+Down). These are
  // menu accelerators rather than a keydown listener so Electron consumes them
  // before the focused terminal can send them to the shell.
  useEffect(() => {
    const prev = window.api.onMenuSelectPrev(() => useStore.getState().selectRelative(-1))
    const next = window.api.onMenuSelectNext(() => useStore.getState().selectRelative(1))
    // Ctrl+H / Ctrl+L (and Cmd+Left / Cmd+Right): the same walk, sideways.
    const left = window.api.onMenuSelectPrevLane(() => useStore.getState().selectLaneRelative(-1))
    const right = window.api.onMenuSelectNextLane(() => useStore.getState().selectLaneRelative(1))
    return () => { prev(); next(); left(); right() }
  }, [])

  // Cmd+C starts a new task when there's nothing selected to copy. Handled in
  // the renderer rather than main's before-input-event, because only the
  // renderer can see whether a selection exists. Capture phase so it runs ahead
  // of xterm, which would otherwise consume the key first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isNewTaskKey(e, navigator.platform.startsWith('Mac'), hasCopyableSelection(document))) return
      e.preventDefault()
      useStore.getState().requestNewTask()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  // View › Toggle List Layout. The preference lives in tasks.json with the split
  // height, so main only sends the request and the renderer owns the flip.
  useEffect(() => window.api.onMenuToggleLayout(() => {
    const { tasks, applyTasks } = useStore.getState()
    applyTasks(toggleLayout(tasks))
  }), [])

  // Worktree › Mark Unread (Ctrl+S U). Acts on the selected worktree, so it's a
  // no-op with nothing selected rather than marking something arbitrary.
  useEffect(() => window.api.onMenuMarkUnread(() => {
    const { selected, toggleUnread } = useStore.getState()
    if (selected) toggleUnread(selected)
  }), [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const w = Math.min(Math.max(window.innerWidth - e.clientX, MIN_DIFF_WIDTH), MAX_DIFF_WIDTH)
      setDiffWidth(w)
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const startDrag = () => {
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div style={{ display: 'flex', height: '100vh', position: 'relative' }}>
      {/* Wezterm-style backdrop: darkened image/video + #282c35 overlay, faded behind the UI */}
      <Backdrop />
      <div style={{ position: 'fixed', inset: 0, zIndex: -1, background: 'rgba(40, 44, 53, 0.72)' }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <MainArea />
      </div>
      {!diffCollapsed && (
        <div onMouseDown={startDrag} title="Drag to resize"
             style={{ width: 5, cursor: 'col-resize', background: '#333', flexShrink: 0 }} />
      )}
      <DiffPanel collapsed={diffCollapsed} width={diffWidth}
                 onToggle={() => setDiffCollapsed(c => !c)} />
      <DiffModal />
      {editingCommands && <CommandsEditor onClose={() => setEditingCommands(false)} />}
    </div>
  )
}
