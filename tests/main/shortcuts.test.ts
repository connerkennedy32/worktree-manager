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

describe('shortcutFor Ctrl+J/Ctrl+K, on both platforms', () => {
  it('maps Ctrl+J to next on macOS', () => {
    expect(shortcutFor(key({ key: 'j', control: true }), true)).toBe('next')
  })

  it('maps Ctrl+K to prev on macOS', () => {
    expect(shortcutFor(key({ key: 'k', control: true }), true)).toBe('prev')
  })

  it('maps Ctrl+J to next off macOS', () => {
    expect(shortcutFor(key({ key: 'j', control: true }), false)).toBe('next')
  })

  it('maps Ctrl+K to prev off macOS', () => {
    expect(shortcutFor(key({ key: 'k', control: true }), false)).toBe('prev')
  })

  it('ignores Ctrl+Meta+J, leaving it free for other bindings', () => {
    expect(shortcutFor(key({ key: 'j', control: true, meta: true }), true)).toBeNull()
  })

  it('ignores bare J/K without Ctrl', () => {
    expect(shortcutFor(key({ key: 'j' }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'k' }), true)).toBeNull()
  })

  it('maps Ctrl+W to new on macOS', () => {
    expect(shortcutFor(key({ key: 'w', control: true }), true)).toBe('new')
  })

  it('maps Ctrl+W to new off macOS', () => {
    expect(shortcutFor(key({ key: 'w', control: true }), false)).toBe('new')
  })

  it('ignores Cmd+W, which closes the window on macOS', () => {
    expect(shortcutFor(key({ key: 'w', meta: true }), true)).toBeNull()
  })

  it('ignores bare W without Ctrl', () => {
    expect(shortcutFor(key({ key: 'w' }), true)).toBeNull()
  })
})
