import { describe, it, expect, beforeEach } from 'vitest'
import type { Worktree } from '@shared/ipc-types'
import { addTask, attachWorktree, emptyTasks, setTaskState, type TasksDoc } from '@shared/tasks'

// store.ts's `select` persists to localStorage, which doesn't exist in the node
// test environment. A minimal in-memory stand-in is enough: these tests care about
// which worktree ends up selected, not about persistence.
const store: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v }
}

const { useStore } = await import('../../src/renderer/state/store')

const wt = (path: string, repoName = 'repo'): Worktree =>
  ({ path, branch: path.slice(1), head: 'abc1234', isMain: false, repoName })

// Every worktree has a task (that is the invariant), so nav order is the board's
// card order. One in-progress task per path, in the order given, unless a test
// builds its own document.
//
// Built by hand rather than through attachWorktree, which promotes a starting
// task to the top of its lane — correct in the app, and the exact opposite of
// what a fixture wants, since it would reverse the order asked for here.
const withTasksFor = (paths: string[]): TasksDoc => ({
  ...emptyTasks(),
  tasks: paths.map((p, i) => ({
    id: `t${i + 1}`,
    title: `task for ${p}`,
    state: 'progress' as const,
    createdAt: 1000 + i,
    worktree: p
  }))
})

const seed = (paths: string[], selected?: string, tasks?: TasksDoc) => {
  const doc = tasks ?? withTasksFor(paths)
  useStore.setState({
    worktrees: paths.map(p => wt(p)),
    repos: ['/code/repo'],
    tasks: doc,
    selected,
    // Where navigation resumes from: the task owning the selected worktree.
    openTaskId: selected ? doc.tasks.find(t => t.worktree === selected)?.id : undefined,
    modalOpen: 0,
    openDiff: null
  })
}

const selectedPath = () => useStore.getState().selected
const openTitle = () => {
  const { tasks, openTaskId } = useStore.getState()
  return tasks.tasks.find(t => t.id === openTaskId)?.title
}

describe('selectRelative', () => {
  beforeEach(() => seed(['/a', '/b', '/c'], '/b'))

  it('selects the next worktree', () => {
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/c')
  })

  it('selects the previous worktree', () => {
    useStore.getState().selectRelative(-1)
    expect(selectedPath()).toBe('/a')
  })

  it('wraps forward from the last worktree to the first', () => {
    seed(['/a', '/b', '/c'], '/c')
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
  })

  it('wraps backward from the first worktree to the last', () => {
    seed(['/a', '/b', '/c'], '/a')
    useStore.getState().selectRelative(-1)
    expect(selectedPath()).toBe('/c')
  })

  it('does nothing when there are no worktrees', () => {
    seed([], undefined)
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBeUndefined()
  })

  it('selects the first worktree when nothing is selected and moving forward', () => {
    seed(['/a', '/b', '/c'], undefined)
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
  })

  it('selects the last worktree when nothing is selected and moving backward', () => {
    seed(['/a', '/b', '/c'], undefined)
    useStore.getState().selectRelative(-1)
    expect(selectedPath()).toBe('/c')
  })

  it('treats a selection that is no longer in the list as no selection', () => {
    // refreshWorktreeList polls every 3s, so `selected` can briefly name a
    // worktree that has since been removed.
    seed(['/a', '/b', '/c'], '/removed')
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
  })

  it('re-selects the only worktree in both directions', () => {
    seed(['/a'], '/a')
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
    useStore.getState().selectRelative(-1)
    expect(selectedPath()).toBe('/a')
  })

  it('does nothing while a modal is open', () => {
    useStore.setState({ modalOpen: 1 })
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/b')
  })

  it('does nothing while the diff modal is open', () => {
    useStore.setState({
      openDiff: { key: '/a.ts:s', path: 'a.ts', staged: true, untracked: false, committed: false }
    })
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/b')
  })
})

describe('pushModal / popModal', () => {
  beforeEach(() => seed(['/a', '/b', '/c'], '/b'))

  it('keeps navigation blocked until the last of two nested modals closes', () => {
    const { pushModal, popModal } = useStore.getState()
    pushModal()
    pushModal()
    popModal()

    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/b')

    popModal()
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/c')
  })
})

describe('selectRelative follows board order', () => {
  it('walks lanes in order — To do, then In progress, then Done', () => {
    // Document order is /a, /b, /c; lane order puts the to-do card first and
    // the done one last, which is what the board draws and the eye follows.
    let tasks = withTasksFor(['/a', '/b', '/c'])
    tasks = setTaskState(tasks, 't1', 'done')
    tasks = setTaskState(tasks, 't2', 'todo')
    seed(['/a', '/b', '/c'], '/b', tasks)
    // /b (To do) -> /c (In progress) -> /a (Done); every card has a live
    // worktree here, so the selection follows the open task.
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/c')
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/b')
  })

  it('stops on a task whose worktree is gone, without changing the selection', () => {
    const base = withTasksFor(['/a', '/b', '/c'])
    // The link is kept, but there is no terminal — stepping here opens the
    // start pane and leaves the previous terminal selected underneath. Rewritten
    // in place rather than through attachWorktree, which would also reorder it.
    const tasks: TasksDoc = {
      ...base,
      tasks: base.tasks.map(t => (t.id === 't2' ? { ...t, worktree: '/removed' } : t))
    }
    seed(['/a', '/c'], '/a', tasks)
    useStore.getState().selectRelative(1)
    expect(openTitle()).toBe('task for /b')
    expect(selectedPath()).toBe('/a')
  })

  it('stops on tasks with no worktree at all', () => {
    let tasks = withTasksFor(['/a', '/b'])
    tasks = addTask(tasks, 'write the changelog', 3000)
    seed(['/a', '/b'], '/b', tasks)
    // /b is last in document order, so forward lands on the worktree-less task.
    useStore.getState().selectRelative(1)
    expect(openTitle()).toBe('write the changelog')
    useStore.getState().selectRelative(1)
    expect(openTitle()).toBe('task for /a')
    expect(selectedPath()).toBe('/a')
  })
})

describe('the repo a new task is for', () => {
  it('remembers the last one chosen, and falls back when it disappears', async () => {
    const { setNewTaskRepo } = useStore.getState()
    setNewTaskRepo('/code/roofworx')
    expect(useStore.getState().newTaskRepo).toBe('/code/roofworx')
    // Re-reading from storage is what a relaunch does.
    const { loadNewTaskRepo } = await import('../../src/renderer/state/seen')
    expect(loadNewTaskRepo()).toBe('/code/roofworx')
  })
})

describe('selectLaneRelative', () => {
  // One card per lane so a sideways step has somewhere to land in both
  // directions, plus a second card in Review to test keeping your place.
  const board = (): TasksDoc => {
    let doc = emptyTasks()
    doc = attachWorktree(addTask(doc, 'todo card', 1000), 't1', '/a')
    doc = setTaskState(doc, 't1', 'todo')
    doc = attachWorktree(addTask(doc, 'progress card', 1001), 't2', '/b')
    doc = attachWorktree(addTask(doc, 'review one', 1002), 't3', '/c')
    doc = setTaskState(doc, 't3', 'review')
    doc = attachWorktree(addTask(doc, 'review two', 1003), 't4', '/d')
    doc = setTaskState(doc, 't4', 'review')
    return doc
  }

  it('steps to the lane on either side', () => {
    seed(['/a', '/b', '/c', '/d'], '/b', board())
    useStore.getState().selectLaneRelative(-1)
    expect(openTitle()).toBe('todo card')
    useStore.getState().selectLaneRelative(1)
    expect(openTitle()).toBe('progress card')
  })

  it('keeps your place in the column, clamped to a shorter lane', () => {
    // Second card of Review, stepping left into a one-card lane.
    seed(['/a', '/b', '/c', '/d'], '/d', board())
    useStore.getState().selectLaneRelative(-1)
    expect(openTitle()).toBe('progress card')
  })

  it('skips an empty lane rather than landing on it', () => {
    // Nothing is in Done, so stepping right off Review wraps to To do.
    seed(['/a', '/b', '/c', '/d'], '/c', board())
    useStore.getState().selectLaneRelative(1)
    expect(openTitle()).toBe('todo card')
  })

  it('opens the first card when nothing is open yet', () => {
    seed(['/a', '/b', '/c', '/d'], undefined, board())
    useStore.getState().selectLaneRelative(1)
    expect(openTitle()).toBe('todo card')
  })

  it('stays put when every other lane is empty', () => {
    let doc = attachWorktree(addTask(emptyTasks(), 'only card', 1000), 't1', '/a')
    doc = setTaskState(doc, 't1', 'review')
    seed(['/a'], '/a', doc)
    useStore.getState().selectLaneRelative(1)
    expect(openTitle()).toBe('only card')
  })

  it('does nothing while a modal is open', () => {
    seed(['/a', '/b', '/c', '/d'], '/b', board())
    useStore.setState({ modalOpen: 1 })
    useStore.getState().selectLaneRelative(-1)
    expect(openTitle()).toBe('progress card')
  })
})

describe('navigating the repo rail', () => {
  // Two repo roots beside a board with one card in To do and one in Review.
  const seedRail = (selected?: string, openTaskId?: string) => {
    let doc = attachWorktree(addTask(emptyTasks(), 'todo card', 1000), 't1', '/a')
    doc = setTaskState(doc, 't1', 'todo')
    doc = attachWorktree(addTask(doc, 'review card', 1001), 't2', '/b')
    doc = setTaskState(doc, 't2', 'review')
    useStore.setState({
      worktrees: [
        { path: '/repo1', branch: 'main', head: 'abc1234', isMain: true, repoName: 'repo1' },
        { path: '/repo2', branch: 'main', head: 'abc1234', isMain: true, repoName: 'repo2' },
        ...['/a', '/b'].map(p => wt(p))
      ],
      repos: ['/repo1', '/repo2'],
      tasks: doc, selected, openTaskId, modalOpen: 0, openDiff: null
    })
  }
  // A root is open when it is selected with no task over it.
  const onRoot = () => {
    const { selected, openTaskId } = useStore.getState()
    return openTaskId ? undefined : selected
  }

  it('steps left off the board onto the rail', () => {
    seedRail('/a', 't1')
    useStore.getState().selectLaneRelative(-1)
    expect(onRoot()).toBe('/repo1')
  })

  it('walks the roots with the same up/down keys the cards use', () => {
    seedRail('/repo1')
    useStore.getState().selectRelative(1)
    expect(onRoot()).toBe('/repo2')
    useStore.getState().selectRelative(1)
    expect(onRoot()).toBe('/repo1')   // wraps
    useStore.getState().selectRelative(-1)
    expect(onRoot()).toBe('/repo2')
  })

  it('steps right off the rail back onto the board, keeping its row', () => {
    seedRail('/repo2')
    useStore.getState().selectLaneRelative(1)
    // Row 2 of the rail, and To do has one card: clamped to its last.
    expect(openTitle()).toBe('todo card')
    expect(onRoot()).toBeUndefined()
  })

  it('wraps from the rail leftwards to the last non-empty lane', () => {
    seedRail('/repo1')
    useStore.getState().selectLaneRelative(-1)
    expect(openTitle()).toBe('review card')
  })

  it('skips the rail when no repo is connected', () => {
    seedRail('/a', 't1')
    useStore.setState({ worktrees: [wt('/a'), wt('/b')] })
    useStore.getState().selectLaneRelative(-1)
    expect(openTitle()).toBe('review card')
  })
})
