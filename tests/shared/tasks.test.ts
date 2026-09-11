import { describe, it, expect } from 'vitest'
import {
  addTask, countTasks, cycleTaskState, emptyTasks, moveTask, parseTasksDoc, removeTask,
  renameTask, setBlocked, setTaskState, setTasksHeight, sortTasks, toggleTasksCollapsed,
  TASKS_MAX_HEIGHT, TASKS_MIN_HEIGHT, type TasksDoc
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

  it('cycles todo -> progress -> done -> todo, and blocked back to progress', () => {
    let doc = withTasks('a')
    doc = cycleTaskState(doc, 't1'); expect(doc.tasks[0].state).toBe('progress')
    doc = cycleTaskState(doc, 't1'); expect(doc.tasks[0].state).toBe('done')
    doc = cycleTaskState(doc, 't1'); expect(doc.tasks[0].state).toBe('todo')
    doc = setBlocked(doc, 't1', 'waiting')
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

  it('sorts open work first and sinks done to the bottom, newest first', () => {
    let doc = withTasks('a', 'b', 'c', 'd')
    doc = setTaskState(doc, 't1', 'done', 100)
    doc = setTaskState(doc, 't2', 'blocked')
    doc = setTaskState(doc, 't3', 'done', 200)
    doc = setTaskState(doc, 't4', 'progress')
    expect(sortTasks(doc.tasks).map(t => t.title)).toEqual(['d', 'b', 'c', 'a'])
  })

  it('counts open, blocked, in-progress and done', () => {
    let doc = withTasks('a', 'b', 'c')
    doc = setTaskState(doc, 't1', 'done')
    doc = setTaskState(doc, 't2', 'blocked')
    expect(countTasks(doc.tasks)).toEqual({ open: 2, blocked: 1, progress: 0, done: 1 })
  })

  it('clamps the section height and toggles collapse', () => {
    expect(setTasksHeight(emptyTasks(), 5).height).toBe(TASKS_MIN_HEIGHT)
    expect(setTasksHeight(emptyTasks(), 99999).height).toBe(TASKS_MAX_HEIGHT)
    expect(setTasksHeight(emptyTasks(), 240).height).toBe(240)
    expect(toggleTasksCollapsed(emptyTasks()).collapsed).toBe(true)
  })

  it('drops malformed tasks on read instead of throwing', () => {
    const parsed = parseTasksDoc({
      tasks: [
        { id: 't1', title: 'ok', state: 'todo', createdAt: 1 },
        { id: 't2', title: 'bad state', state: 'nope', createdAt: 1 },
        { title: 'no id', state: 'todo', createdAt: 1 },
        'not even an object'
      ],
      collapsed: true,
      height: 10_000
    })
    expect(parsed.tasks.map(t => t.id)).toEqual(['t1'])
    expect(parsed.collapsed).toBe(true)
    expect(parsed.height).toBe(TASKS_MAX_HEIGHT)
  })

  it('degrades to an empty doc for junk input', () => {
    expect(parseTasksDoc(null).tasks).toEqual([])
    expect(parseTasksDoc({}).collapsed).toBe(false)
  })
})
