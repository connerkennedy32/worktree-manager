import { describe, it, expect } from 'vitest'
import { shortcutFor, type KeyInput } from '../../src/main/shortcuts'

const key = (over: Partial<KeyInput> = {}): KeyInput =>
  ({ type: 'keyDown', key: 'ArrowDown', meta: false, control: false, alt: false, shift: false, ...over })

describe('shortcutFor on macOS', () => {
  const mac = (over: Partial<KeyInput>) => shortcutFor(key(over), true)

  it('maps Cmd+Down to next', () => {
    expect(mac({ key: 'ArrowDown', meta: true })).toBe('next')
  })

  it('maps Cmd+Up to prev', () => {
    expect(mac({ key: 'ArrowUp', meta: true })).toBe('prev')
  })

  it('ignores a bare arrow key, which the terminal needs for history and cursor movement', () => {
    expect(mac({ key: 'ArrowDown' })).toBeNull()
  })

  it('ignores Ctrl+Down, which is a terminal control sequence on macOS', () => {
    expect(mac({ key: 'ArrowDown', control: true })).toBeNull()
  })

  it('ignores key-up events so one press moves exactly one worktree', () => {
    expect(mac({ key: 'ArrowDown', meta: true, type: 'keyUp' })).toBeNull()
  })

  it('ignores non-arrow keys', () => {
    expect(mac({ key: 'a', meta: true })).toBeNull()
  })

  it('ignores Cmd+Shift+Down, leaving it free for other bindings', () => {
    expect(mac({ key: 'ArrowDown', meta: true, shift: true })).toBeNull()
  })

  it('ignores Cmd+Alt+Down, leaving it free for other bindings', () => {
    expect(mac({ key: 'ArrowDown', meta: true, alt: true })).toBeNull()
  })
})

describe('shortcutFor off macOS', () => {
  const other = (over: Partial<KeyInput>) => shortcutFor(key(over), false)

  it('maps Ctrl+Down to next', () => {
    expect(other({ key: 'ArrowDown', control: true })).toBe('next')
  })

  it('maps Ctrl+Up to prev', () => {
    expect(other({ key: 'ArrowUp', control: true })).toBe('prev')
  })

  it('ignores Cmd+Down, since Cmd is not the modifier off macOS', () => {
    expect(other({ key: 'ArrowDown', meta: true })).toBeNull()
  })
})
