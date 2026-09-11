import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { emptyTasks, TASKS_DEFAULT_HEIGHT, type TasksDoc } from '../../src/shared/tasks'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wtm-tasks-')); process.env.WTM_CONFIG_DIR = dir })

const sample = (): TasksDoc => ({
  tasks: [
    { id: 't1', title: 'Ship the tasks panel', state: 'progress', createdAt: 1 },
    { id: 't2', title: 'Openly fixture', state: 'blocked', reason: 'waiting on sample', createdAt: 2 }
  ],
  collapsed: false,
  height: 220
})

describe('tasks config', () => {
  it('returns an empty doc when the file does not exist', async () => {
    const { readTasks } = await import('../../src/main/config')
    expect(await readTasks()).toEqual(emptyTasks())
  })

  it('round-trips a document', async () => {
    const { readTasks, writeTasks } = await import('../../src/main/config')
    expect(await writeTasks(sample())).toEqual(sample())
    expect(await readTasks()).toEqual(sample())
  })

  it('degrades to an empty doc when the file is corrupt', async () => {
    writeFileSync(join(dir, 'tasks.json'), '{not json')
    const { readTasks } = await import('../../src/main/config')
    expect(await readTasks()).toEqual(emptyTasks())
  })

  it('sanitizes on write, so a bad row never reaches disk', async () => {
    const { readTasks, writeTasks } = await import('../../src/main/config')
    await writeTasks({
      tasks: [{ id: 't1', title: 'ok', state: 'todo', createdAt: 1 }, { id: 't2' } as any],
      collapsed: false,
      height: Number.NaN
    })
    const back = await readTasks()
    expect(back.tasks.map(t => t.id)).toEqual(['t1'])
    expect(back.height).toBe(TASKS_DEFAULT_HEIGHT)
  })
})
