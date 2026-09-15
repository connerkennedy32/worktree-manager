import { describe, it, expect } from 'vitest'
import {
  hasCopyableSelection, isNewTaskKey, type KeyLike,
  taskDigit
} from '../../src/renderer/state/task-keys'

const key = (over: Partial<KeyLike> = {}): KeyLike =>
  ({ key: 'c', code: 'KeyC', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...over })

describe('Cmd+C opens a new task only when there is nothing to copy', () => {
  it('fires on Cmd+C with no selection', () => {
    expect(isNewTaskKey(key(), true, false)).toBe(true)
  })

  it('stays out of the way when something is selected, so copy still works', () => {
    expect(isNewTaskKey(key(), true, true)).toBe(false)
  })

  it('matches on the physical key, and on the character when code is absent', () => {
    expect(isNewTaskKey(key({ code: 'KeyC', key: 'ç' }), true, false)).toBe(true)
    expect(isNewTaskKey(key({ code: undefined, key: 'C' }), true, false)).toBe(true)
    expect(isNewTaskKey(key({ code: 'KeyV' }), true, false)).toBe(false)
  })

  it('leaves Ctrl+C alone on macOS, since that is SIGINT in the terminal', () => {
    expect(isNewTaskKey(key({ metaKey: false, ctrlKey: true }), true, false)).toBe(false)
  })

  it('leaves Ctrl+C alone off macOS too, for the same reason', () => {
    expect(isNewTaskKey(key({ metaKey: false, ctrlKey: true }), false, false)).toBe(false)
  })

  it('ignores the modified variants, which belong to other bindings', () => {
    expect(isNewTaskKey(key({ shiftKey: true }), true, false)).toBe(false)
    expect(isNewTaskKey(key({ altKey: true }), true, false)).toBe(false)
    expect(isNewTaskKey(key({ ctrlKey: true }), true, false)).toBe(false)
  })

  it('ignores a bare C, so typing is untouched', () => {
    expect(isNewTaskKey(key({ metaKey: false }), true, false)).toBe(false)
  })
})

describe('hasCopyableSelection', () => {
  const doc = (over: any) => over as unknown as Document

  it('sees a selection inside a focused input', () => {
    expect(hasCopyableSelection(doc({
      activeElement: { tagName: 'INPUT', selectionStart: 0, selectionEnd: 4 },
      getSelection: () => null
    }))).toBe(true)
  })

  it('ignores a caret with no range in an input', () => {
    expect(hasCopyableSelection(doc({
      activeElement: { tagName: 'INPUT', selectionStart: 2, selectionEnd: 2 },
      getSelection: () => null
    }))).toBe(false)
  })

  it('sees a page selection, such as text dragged in the terminal', () => {
    expect(hasCopyableSelection(doc({
      activeElement: null,
      getSelection: () => ({ isCollapsed: false, toString: () => 'npm run dev' })
    }))).toBe(true)
  })

  it('treats an empty or collapsed selection as nothing to copy', () => {
    expect(hasCopyableSelection(doc({
      activeElement: null, getSelection: () => ({ isCollapsed: true, toString: () => '' })
    }))).toBe(false)
    expect(hasCopyableSelection(doc({
      activeElement: null, getSelection: () => ({ isCollapsed: false, toString: () => '' })
    }))).toBe(false)
    expect(hasCopyableSelection(doc({ activeElement: null, getSelection: () => null }))).toBe(false)
  })
})

describe('Cmd+<number> picks a task', () => {
  const digit = (over: Partial<KeyLike> = {}): KeyLike =>
    ({ key: '3', code: 'Digit3', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...over })

  it('reads the position from the physical number row', () => {
    expect(taskDigit(digit(), true)).toBe(3)
    expect(taskDigit(digit({ code: 'Digit1', key: '1' }), true)).toBe(1)
    expect(taskDigit(digit({ code: 'Digit9', key: '9' }), true)).toBe(9)
  })

  it('falls back to the character when there is no code', () => {
    expect(taskDigit(digit({ code: undefined, key: '4' }), true)).toBe(4)
  })

  it('ignores zero, which would have to mean "the tenth"', () => {
    expect(taskDigit(digit({ code: 'Digit0', key: '0' }), true)).toBeNull()
  })

  it('needs the platform modifier, so typing a number is untouched', () => {
    expect(taskDigit(digit({ metaKey: false }), true)).toBeNull()
    expect(taskDigit(digit({ metaKey: false, ctrlKey: true }), true)).toBeNull()
    expect(taskDigit(digit({ metaKey: false, ctrlKey: true }), false)).toBe(3)
  })

  it('ignores the modified variants', () => {
    expect(taskDigit(digit({ shiftKey: true }), true)).toBeNull()
    expect(taskDigit(digit({ altKey: true }), true)).toBeNull()
  })

})
