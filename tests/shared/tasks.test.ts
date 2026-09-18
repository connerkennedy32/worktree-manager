import { describe, it, expect } from 'vitest'
import {
  addTask, countTasks, cycleTaskState, emptyTasks, moveTask, parseTasksDoc, removeTask,
  renameTask, setBlocked, setTaskNote, setTaskState, setBoardHeight, resolveBoardHeight,
  attachWorktree, detachWorktree, dropTask, laneOf, reconcileTasks, taskForWorktree,
  LANES, tasksInLane, noteAgentWorking, noteAgentFinished,
  BOARD_HALF, BOARD_MAX_HEIGHT, BOARD_MIN_HEIGHT, MIN_TERMINAL_HEIGHT,
  setLayout, toggleLayout, setListWidth,
  LIST_DEFAULT_WIDTH, LIST_MAX_WIDTH, LIST_MIN_WIDTH, type TasksDoc
} from '../../src/shared/tasks'

const withTasks = (...titles: string[]): TasksDoc =>
  titles.reduce((doc, t, i) => addTask(doc, t, 1000 + i), emptyTasks())

describe('tasks model', () => {
  it('adds tasks as todo with unique ids and drops blank titles', () => {
    const doc = addTask(addTask(emptyTasks(), 'first'), '   ')
    expect(doc.tasks.map(t => t.title)).toEqual(['first'])
    expect(doc.tasks[0].state).toBe('todo')
    expect(new Set(withTasks('a', 'b', 'c').tasks.map(t => t.id)).size).toBe(3)
  })

  it('reuses a freed id rather than colliding with a live one', () => {
    const doc = removeTask(withTasks('a', 'b'), 't1')
    expect(addTask(doc, 'c').tasks.map(t => t.id).sort()).toEqual(['t1', 't2'])
  })

  it('cycles todo -> progress -> review -> done -> todo, and blocked back to its lane', () => {
    let doc = withTasks('a')
    doc = cycleTaskState(doc, 't1'); expect(doc.tasks[0].state).toBe('progress')
    doc = cycleTaskState(doc, 't1'); expect(doc.tasks[0].state).toBe('review')
    doc = cycleTaskState(doc, 't1'); expect(doc.tasks[0].state).toBe('done')
    doc = cycleTaskState(doc, 't1'); expect(doc.tasks[0].state).toBe('todo')
    // Blocked from To do unblocks back to To do, not into started work.
    doc = setBlocked(doc, 't1', 'waiting')
    expect(cycleTaskState(doc, 't1').tasks[0].state).toBe('todo')
    doc = setBlocked(setTaskState(doc, 't1', 'progress'), 't1', 'waiting')
    expect(cycleTaskState(doc, 't1').tasks[0].state).toBe('progress')
  })

  it('stamps doneAt on finishing and clears it on reopening', () => {
    const done = setTaskState(withTasks('a'), 't1', 'done', 5000)
    expect(done.tasks[0].doneAt).toBe(5000)
    expect(setTaskState(done, 't1', 'todo').tasks[0].doneAt).toBeUndefined()
  })

  it('blocking stores a trimmed reason and sets the state', () => {
    const doc = setBlocked(withTasks('a'), 't1', '  needs the API key  ')
    expect(doc.tasks[0]).toMatchObject({ state: 'blocked', reason: 'needs the API key' })
  })

  it('keeps the reason when unblocking, so an accidental unblock loses nothing', () => {
    const doc = setTaskState(setBlocked(withTasks('a'), 't1', 'waiting'), 't1', 'todo')
    expect(doc.tasks[0]).toMatchObject({ state: 'todo', reason: 'waiting' })
  })

  it('ignores a rename to nothing rather than leaving a blank row', () => {
    expect(renameTask(withTasks('a'), 't1', '   ').tasks[0].title).toBe('a')
    expect(renameTask(withTasks('a'), 't1', ' b ').tasks[0].title).toBe('b')
  })

  it('reorders by anchor, on either edge', () => {
    const doc = withTasks('a', 'b', 'c')
    expect(moveTask(doc, 't3', 't1', false).tasks.map(t => t.title)).toEqual(['c', 'a', 'b'])
    expect(moveTask(doc, 't1', 't3', true).tasks.map(t => t.title)).toEqual(['b', 'c', 'a'])
    expect(moveTask(doc, 't1', 't1', true).tasks.map(t => t.title)).toEqual(['a', 'b', 'c'])
  })

  it('leaves a task where it sits when it goes to todo or blocked', () => {
    // Order is still the user's for the lanes they curate by hand. Starting and
    // finishing are the two exceptions — see the promotion tests below.
    let doc = withTasks('a', 'b', 'c')
    doc = setTaskState(doc, 't3', 'todo')
    doc = setBlocked(doc, 't2', 'waiting')
    expect(doc.tasks.map(t => t.title)).toEqual(['a', 'b', 'c'])
  })

  it('counts open, blocked, in-progress and done', () => {
    let doc = withTasks('a', 'b', 'c')
    doc = setTaskState(doc, 't1', 'done')
    doc = setTaskState(doc, 't2', 'blocked')
    expect(countTasks(doc.tasks)).toEqual({ open: 2, blocked: 1, progress: 0, review: 0, done: 1 })
    doc = setTaskState(doc, 't3', 'review')
    expect(countTasks(doc.tasks)).toMatchObject({ open: 2, review: 1, done: 1 })
  })

  it('clamps a dragged board height but lets the half-window sentinel through', () => {
    expect(setBoardHeight(emptyTasks(), 5).height).toBe(BOARD_MIN_HEIGHT)
    expect(setBoardHeight(emptyTasks(), 99999).height).toBe(BOARD_MAX_HEIGHT)
    expect(setBoardHeight(emptyTasks(), 420).height).toBe(420)
    expect(setBoardHeight(emptyTasks(), BOARD_HALF).height).toBe(BOARD_HALF)
    expect(setBoardHeight(emptyTasks(), Number.NaN).height).toBe(BOARD_HALF)
  })

  it('toggles between the two layouts and keeps everything else', () => {
    const doc = addTask(emptyTasks(), 'a task')
    expect(doc.layout).toBe('board')
    const list = toggleLayout(doc)
    expect(list.layout).toBe('list')
    expect(list.tasks).toEqual(doc.tasks)
    expect(toggleLayout(list).layout).toBe('board')
  })

  it('leaves the document alone when the layout is already the one asked for', () => {
    const doc = emptyTasks()
    expect(setLayout(doc, 'board')).toBe(doc)
    expect(setLayout(doc, 'list')).not.toBe(doc)
  })

  it('clamps a dragged list width, with no sentinel to let through', () => {
    expect(setListWidth(emptyTasks(), 5).listWidth).toBe(LIST_MIN_WIDTH)
    expect(setListWidth(emptyTasks(), 99999).listWidth).toBe(LIST_MAX_WIDTH)
    expect(setListWidth(emptyTasks(), 300).listWidth).toBe(300)
    expect(setListWidth(emptyTasks(), Number.NaN).listWidth).toBe(LIST_DEFAULT_WIDTH)
  })

  it('reads the layout fail-soft: anything but "list" is the board', () => {
    expect(parseTasksDoc({ tasks: [] }).layout).toBe('board')
    expect(parseTasksDoc({ tasks: [], layout: 'list' }).layout).toBe('list')
    expect(parseTasksDoc({ tasks: [], layout: 'nonsense' }).layout).toBe('board')
    expect(parseTasksDoc({ tasks: [], layout: 7 }).layout).toBe('board')
    // A width from an older file, or a corrupt one, still lands in range.
    expect(parseTasksDoc({ tasks: [] }).listWidth).toBe(LIST_DEFAULT_WIDTH)
    expect(parseTasksDoc({ tasks: [], listWidth: 9999 }).listWidth).toBe(LIST_MAX_WIDTH)
    expect(parseTasksDoc({ tasks: [], listWidth: 'wide' }).listWidth).toBe(LIST_DEFAULT_WIDTH)
  })

  it('resolves the board height against the window it is in', () => {
    // Never dragged: half the window, whatever the window turns out to be.
    expect(resolveBoardHeight(BOARD_HALF, 900)).toBe(450)
    expect(resolveBoardHeight(BOARD_HALF, 1200)).toBe(600)
    // Dragged: honored, until it would leave no usable terminal.
    expect(resolveBoardHeight(400, 900)).toBe(400)
    expect(resolveBoardHeight(880, 900)).toBe(900 - MIN_TERMINAL_HEIGHT)
    // A window shorter than the minimums still shows a board.
    expect(resolveBoardHeight(500, 200)).toBe(BOARD_MIN_HEIGHT)
  })

  it('drops malformed tasks on read instead of throwing', () => {
    const parsed = parseTasksDoc({
      tasks: [
        { id: 't1', title: 'ok', state: 'todo', createdAt: 1 },
        { id: 't2', title: 'bad state', state: 'nope', createdAt: 1 },
        { title: 'no id', state: 'todo', createdAt: 1 },
        'not even an object'
      ],
      height: 10_000
    })
    expect(parsed.tasks.map(t => t.id)).toEqual(['t1'])
    expect(parsed.height).toBe(BOARD_MAX_HEIGHT)
  })

  it('degrades to an empty doc for junk input', () => {
    expect(parseTasksDoc(null).tasks).toEqual([])
    expect(parseTasksDoc({}).height).toBe(BOARD_HALF)
  })
})

const wt = (path: string, branch: string, isMain = false) => ({ path, branch, isMain })

describe('worktrees on tasks', () => {
  it('attaching a worktree starts the task; detaching leaves it where it was', () => {
    let doc = withTasks('build the board')
    doc = attachWorktree(doc, 't1', '/wt/board', '/repo')
    expect(doc.tasks[0]).toMatchObject({ state: 'progress', worktree: '/wt/board', repo: '/repo' })
    doc = detachWorktree(doc, 't1')
    expect(doc.tasks[0].worktree).toBeUndefined()
    expect(doc.tasks[0].state).toBe('progress')
  })

  it('attaching to a blocked task does not unblock it', () => {
    const doc = attachWorktree(setBlocked(withTasks('a'), 't1', 'waiting'), 't1', '/wt/a')
    expect(doc.tasks[0].state).toBe('blocked')
    expect(doc.tasks[0].reason).toBe('waiting')
  })

  it('finds the task that owns a worktree', () => {
    const doc = attachWorktree(withTasks('a', 'b'), 't2', '/wt/b')
    expect(taskForWorktree(doc, '/wt/b')?.id).toBe('t2')
    expect(taskForWorktree(doc, '/wt/missing')).toBeUndefined()
  })
})

describe('reconcileTasks', () => {
  it('creates an in-progress task for every unclaimed worktree, skipping main', () => {
    const doc = reconcileTasks(emptyTasks(),
      [wt('/code/repo', 'main', true), wt('/wt/a', 'ck/a'), wt('/wt/b', 'ck/b')],
      { '/wt/b': 'Nice name' }, { '/wt/a': '/repo', '/wt/b': '/repo' }, 5000)
    // The repo root belongs to the rail, not to a lane.
    expect(doc.tasks.map(t => t.title)).toEqual(['ck/a', 'Nice name'])
    expect(doc.tasks.every(t => t.state === 'progress' && t.fromDisk === true)).toBe(true)
    expect(doc.tasks[0]).toMatchObject({ worktree: '/wt/a', repo: '/repo', createdAt: 5000 })
  })

  it('drops a reconciler-made card left over from when roots were cards', () => {
    const before = reconcileTasks(emptyTasks(), [wt('/wt/a', 'ck/a')])
    const stale = { ...before, tasks: [...before.tasks,
      { id: 't9', title: 'repo', state: 'progress' as const, createdAt: 1, worktree: '/code/repo', fromDisk: true }] }
    expect(reconcileTasks(stale, [wt('/code/repo', 'main', true), wt('/wt/a', 'ck/a')]).tasks
      .map(t => t.worktree)).toEqual(['/wt/a'])
  })

  it('drops a legacy root card that predates the fromDisk flag', () => {
    // The old rule titled a root for its directory, so that is what identifies
    // one of its cards now that the flag is missing.
    const doc = attachWorktree(withTasks('repo'), 't1', '/code/repo')
    expect(reconcileTasks(doc, [wt('/code/repo', 'main', true)]).tasks).toEqual([])
  })

  it("keeps a root card the user wrote themselves, minus the link", () => {
    const doc = attachWorktree(withTasks('clean up the root'), 't1', '/code/repo')
    const after = reconcileTasks(doc, [wt('/code/repo', 'main', true)])
    expect(after.tasks).toEqual([{ ...doc.tasks[0], worktree: undefined }])
  })

  it('is identity when every worktree already has a task', () => {
    const doc = attachWorktree(withTasks('a'), 't1', '/wt/a')
    expect(reconcileTasks(doc, [wt('/code/repo', 'main', true), wt('/wt/a', 'ck/a')])).toBe(doc)
  })

  it('leaves a task whose worktree has disappeared alone', () => {
    const doc = attachWorktree(withTasks('a'), 't1', '/wt/gone')
    expect(reconcileTasks(doc, []).tasks[0].worktree).toBe('/wt/gone')
  })

  it('drops a second card minted for a worktree a task already holds', () => {
    const doc = attachWorktree(withTasks('Dive in'), 't1', '/wt/a')
    const dup = { ...doc, tasks: [...doc.tasks, {
      id: 't9', title: 'ck/a', state: 'progress' as const, createdAt: 0, worktree: '/wt/a'
    }] }
    const after = reconcileTasks(dup, [wt('/wt/a', 'ck/a')])
    expect(after.tasks.map(t => t.id)).toEqual(['t1'])
  })

  it('keeps a duplicate the user named, and only unlinks it', () => {
    const doc = attachWorktree(withTasks('Dive in'), 't1', '/wt/a')
    const dup = { ...doc, tasks: [...doc.tasks, {
      id: 't9', title: 'My own note', state: 'progress' as const, createdAt: 0, worktree: '/wt/a'
    }] }
    const after = reconcileTasks(dup, [wt('/wt/a', 'ck/a')])
    expect(after.tasks.map(t => [t.id, t.worktree])).toEqual([['t1', '/wt/a'], ['t9', undefined]])
  })

  it('renaming a reconciled task clears the placeholder flag', () => {
    const doc = reconcileTasks(emptyTasks(), [wt('/wt/a', 'ck/a')])
    expect(renameTask(doc, 't1', 'Real title').tasks[0].fromDisk).toBeUndefined()
  })
})

describe('board lanes', () => {
  it('blocks a card in the lane it was blocked in', () => {
    let doc = withTasks('a', 'b')
    doc = setTaskState(doc, 't2', 'progress')
    doc = setBlocked(setBlocked(doc, 't1', 'waiting'), 't2', 'waiting')
    // A to-do can be stuck before anyone starts it, so it blocks in place.
    expect(laneOf(doc.tasks.find(t => t.id === 't1')!)).toBe('todo')
    expect(laneOf(doc.tasks.find(t => t.id === 't2')!)).toBe('progress')
    expect(tasksInLane(doc, 'todo').map(t => t.id)).toEqual(['t1'])
    expect(tasksInLane(doc, 'progress').map(t => t.id)).toEqual(['t2'])
  })

  it('reads a blocked task with no recorded lane as in progress', () => {
    const doc = parseTasksDoc({
      tasks: [{ id: 't1', title: 'a', state: 'blocked', createdAt: 1 }]
    })
    expect(laneOf(doc.tasks[0])).toBe('progress')
  })

  it('drags a blocked card between to-do and in progress without unblocking', () => {
    let doc = setBlocked(withTasks('a', 'b'), 't1', 'waiting')
    doc = dropTask(doc, 't1', 'progress', undefined, 7000)
    expect(doc.tasks[0].state).toBe('blocked')
    expect(laneOf(doc.tasks[0])).toBe('progress')
    doc = dropTask(doc, 't1', 'todo', undefined, 7000)
    expect(doc.tasks[0].state).toBe('blocked')
    expect(laneOf(doc.tasks[0])).toBe('todo')
    // Review has no blocked rendering, so dropping there clears the block.
    doc = dropTask(doc, 't1', 'review', undefined, 7000)
    expect(doc.tasks[0].state).toBe('review')
  })

  it('drops set the lane state and the position in one write', () => {
    let doc = withTasks('a', 'b', 'c')
    doc = dropTask(doc, 't3', 'progress', { id: 't1', after: false }, 7000)
    expect(doc.tasks.map(t => t.id)).toEqual(['t3', 't1', 't2'])
    expect(doc.tasks[0].state).toBe('progress')
    doc = dropTask(doc, 't3', 'done', undefined, 7000)
    expect(doc.tasks.find(t => t.id === 't3')).toMatchObject({ state: 'done', doneAt: 7000 })
  })

  it('a drag within In progress reorders a blocked card without unblocking it', () => {
    let doc = setBlocked(withTasks('a', 'b'), 't2', 'waiting')
    doc = dropTask(doc, 't2', 'progress', { id: 't1', after: false })
    expect(doc.tasks.map(t => t.id)).toEqual(['t2', 't1'])
    expect(doc.tasks[0].state).toBe('blocked')
  })
})

describe('in review', () => {
  it('has its own lane, between in progress and done', () => {
    expect(LANES).toEqual(['todo', 'progress', 'review', 'done'])
    const doc = setTaskState(withTasks('a'), 't1', 'review')
    expect(laneOf(doc.tasks[0])).toBe('review')
    expect(tasksInLane(doc, 'review').map(t => t.id)).toEqual(['t1'])
  })

  it('dropping into the review lane sets the state', () => {
    const doc = dropTask(withTasks('a', 'b'), 't1', 'review')
    expect(doc.tasks[0].state).toBe('review')
    // Leaving review for done still stamps the finish time.
    const done = dropTask(doc, 't1', 'done', undefined, 9000)
    expect(done.tasks.find(t => t.id === 't1')?.doneAt).toBe(9000)
  })
})


describe('promotion to the top of a lane', () => {
  it('pops a task to the top of its column when it starts', () => {
    let doc = withTasks('a', 'b', 'c')
    doc = setTaskState(doc, 't1', 'progress')
    doc = setTaskState(doc, 't3', 'progress')
    // t3 started last, so it leads the In progress lane.
    expect(tasksInLane(doc, 'progress').map(t => t.id)).toEqual(['t3', 't1'])
  })

  it('pops a task to the top of Done when it finishes', () => {
    let doc = withTasks('a', 'b', 'c')
    doc = setTaskState(doc, 't1', 'done')
    doc = setTaskState(doc, 't2', 'done')
    expect(tasksInLane(doc, 'done').map(t => t.id)).toEqual(['t2', 't1'])
  })

  it('leaves to-do and blocked order alone', () => {
    let doc = withTasks('a', 'b', 'c')
    doc = setTaskState(doc, 't3', 'todo')
    expect(tasksInLane(doc, 'todo').map(t => t.id)).toEqual(['t1', 't2', 't3'])
    doc = setBlocked(doc, 't3', 'waiting')
    // Blocking a to-do keeps it in To do, and exactly where it sat.
    expect(tasksInLane(doc, 'todo').map(t => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('does not disturb the other lanes', () => {
    let doc = withTasks('a', 'b', 'c', 'd')
    doc = setTaskState(doc, 't1', 'done')
    doc = setTaskState(doc, 't4', 'done')
    expect(tasksInLane(doc, 'todo').map(t => t.id)).toEqual(['t2', 't3'])
  })

  it('attaching a worktree promotes, unless the task is blocked', () => {
    let doc = withTasks('a', 'b')
    doc = setTaskState(doc, 't1', 'progress')
    doc = attachWorktree(doc, 't2', '/wt/b')
    expect(tasksInLane(doc, 'progress').map(t => t.id)).toEqual(['t2', 't1'])
    doc = setBlocked(doc, 't2', 'waiting')
    doc = attachWorktree(doc, 't2', '/wt/b2')
    expect(tasksInLane(doc, 'progress').map(t => t.id)).toEqual(['t2', 't1'])
  })

  it('a drop onto a specific card still lands there', () => {
    let doc = withTasks('a', 'b', 'c')
    doc = setTaskState(doc, 't1', 'progress')
    doc = setTaskState(doc, 't2', 'progress')
    // Dragged below t1 rather than to the top, which is what was asked for.
    doc = dropTask(doc, 't3', 'progress', { id: 't1', after: true })
    expect(tasksInLane(doc, 'progress').map(t => t.id)).toEqual(['t2', 't1', 't3'])
  })

  it('a drop on the lane background promotes', () => {
    let doc = withTasks('a', 'b', 'c')
    doc = setTaskState(doc, 't1', 'progress')
    doc = dropTask(doc, 't3', 'progress')
    expect(tasksInLane(doc, 'progress').map(t => t.id)).toEqual(['t3', 't1'])
  })
})

describe('an agent starting work', () => {
  const withWorktrees = (...paths: string[]): TasksDoc => ({
    ...emptyTasks(),
    tasks: paths.map((p, i) => ({
      id: `t${i + 1}`, title: `task for ${p}`, state: 'progress' as const,
      createdAt: 1000 + i, worktree: p
    }))
  })

  it('marks the task in progress and pops it to the top', () => {
    let doc = withWorktrees('/wt/a', '/wt/b')
    doc = setTaskState(doc, 't2', 'todo')
    doc = noteAgentWorking(doc, '/wt/b', 5000)
    expect(doc.tasks.find(t => t.id === 't2')?.state).toBe('progress')
    expect(tasksInLane(doc, 'progress').map(t => t.id)).toEqual(['t2', 't1'])
  })

  it('pops a task that is already in progress but further down', () => {
    const doc = withWorktrees('/wt/a', '/wt/b', '/wt/c')
    expect(tasksInLane(noteAgentWorking(doc, '/wt/c'), 'progress').map(t => t.id))
      .toEqual(['t3', 't1', 't2'])
  })

  it('settles below the worktrees whose agents are still running', () => {
    // Two agents going at once: each tool call would otherwise leapfrog the
    // other and the two cards would trade places every few seconds.
    const doc = withWorktrees('/wt/a', '/wt/b', '/wt/c')
    const busy = (w: string) => w === '/wt/a'
    expect(tasksInLane(noteAgentWorking(doc, '/wt/c', 5000, busy), 'progress').map(t => t.id))
      .toEqual(['t1', 't3', 't2'])
    // And once it is parked there, re-asserting changes nothing.
    const settled = noteAgentWorking(doc, '/wt/c', 5000, busy)
    expect(noteAgentWorking(settled, '/wt/c', 5000, busy)).toBe(settled)
  })

  it('promotes a to-do below the running cards rather than above them', () => {
    let doc = withWorktrees('/wt/a', '/wt/b')
    doc = setTaskState(doc, 't2', 'todo')
    doc = noteAgentWorking(doc, '/wt/b', 5000, w => w === '/wt/a')
    expect(tasksInLane(doc, 'progress').map(t => t.id)).toEqual(['t1', 't2'])
  })

  it('is identity once the card is in progress and on top', () => {
    // `working` re-asserts on every tool call; an unequal doc here would write
    // tasks.json to disk dozens of times a turn.
    const doc = withWorktrees('/wt/a', '/wt/b')
    expect(noteAgentWorking(doc, '/wt/a')).toBe(doc)
  })

  it('pops a finished agent above the ones still working, without touching state', () => {
    let doc = withWorktrees('/wt/a', '/wt/b', '/wt/c')
    doc = noteAgentFinished(doc, '/wt/c')
    expect(tasksInLane(doc, 'progress').map(t => t.id)).toEqual(['t3', 't1', 't2'])
    expect(doc.tasks.find(t => t.id === 't3')?.state).toBe('progress')
    // Already first: identity, so tasks.json stays put.
    expect(noteAgentFinished(doc, '/wt/c')).toBe(doc)
    // And a blocked card or an unclaimed worktree is left alone.
    expect(noteAgentFinished(setBlocked(doc, 't1', 'waiting'), '/wt/a').tasks[0].id).toBe('t3')
    expect(noteAgentFinished(doc, '/wt/nobody')).toBe(doc)
  })

  it('leaves a blocked task blocked, and ignores an unclaimed worktree', () => {
    const doc = setBlocked(withWorktrees('/wt/a', '/wt/b'), 't2', 'waiting on a key')
    expect(noteAgentWorking(doc, '/wt/b')).toBe(doc)
    expect(noteAgentWorking(doc, '/wt/nobody')).toBe(doc)
  })

  it('keeps a task in review, but pops it to the top of that lane', () => {
    // Prompting an agent on a card under review is part of reviewing it, so the
    // state stands — the card still comes first, the way In progress does.
    let doc = withWorktrees('/wt/a', '/wt/b', '/wt/c')
    doc = setTaskState(doc, 't2', 'review')
    doc = setTaskState(doc, 't3', 'review')
    const next = noteAgentWorking(doc, '/wt/b')
    expect(next.tasks.find(t => t.id === 't2')?.state).toBe('review')
    expect(tasksInLane(next, 'review').map(t => t.id)).toEqual(['t2', 't3'])
    // Already on top: identity, so no needless write.
    expect(noteAgentWorking(next, '/wt/b')).toBe(next)
  })

  it('reopens a finished task when its agent starts again', () => {
    let doc = withWorktrees('/wt/a', '/wt/b')
    doc = setTaskState(doc, 't2', 'done', 4000)
    doc = noteAgentWorking(doc, '/wt/b', 6000)
    expect(doc.tasks.find(t => t.id === 't2')).toMatchObject({ state: 'progress', doneAt: undefined })
  })
})

describe('task notes', () => {
  it('keeps a note across state changes, and survives a round trip', () => {
    let doc = setTaskNote(withTasks('a', 'b'), 't1', '  Carson is reviewing this  ')
    expect(doc.tasks[0].note).toBe('Carson is reviewing this')
    doc = setTaskState(doc, 't1', 'done', 5000)
    const find = (d: TasksDoc) => d.tasks.find(t => t.id === 't1')?.note
    expect(find(doc)).toBe('Carson is reviewing this')
    expect(find(parseTasksDoc(JSON.parse(JSON.stringify(doc)))))
      .toBe('Carson is reviewing this')
  })

  it('clears the note when it is emptied, rather than storing blank text', () => {
    const doc = setTaskNote(setTaskNote(withTasks('a'), 't1', 'ping Carson'), 't1', '   ')
    expect(doc.tasks[0].note).toBeUndefined()
  })
})
