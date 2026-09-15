import { describe, it, expect } from 'vitest'
import {
  CHORD_TIMEOUT_MS, isChordPrefix, isModifierKey, resolveKey, shortcutFor, type KeyInput
} from '../../src/main/shortcuts'

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

  it('maps Ctrl+H and Ctrl+L to the columns either side, on both platforms', () => {
    for (const isMac of [true, false]) {
      expect(shortcutFor(key({ key: 'h', control: true }), isMac)).toBe('prevLane')
      expect(shortcutFor(key({ key: 'l', control: true }), isMac)).toBe('nextLane')
    }
  })

  it('maps Cmd+Left/Right to the columns either side on macOS', () => {
    expect(shortcutFor(key({ key: 'ArrowLeft', meta: true }), true)).toBe('prevLane')
    expect(shortcutFor(key({ key: 'ArrowRight', meta: true }), true)).toBe('nextLane')
  })

  it('leaves bare H/L and Cmd+H alone', () => {
    expect(shortcutFor(key({ key: 'h' }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'l' }), true)).toBeNull()
    // Cmd+H hides the app on macOS, and Ctrl+Meta is someone else's binding.
    expect(shortcutFor(key({ key: 'h', control: true, meta: true }), true)).toBeNull()
  })

  it('ignores bare J/K without Ctrl', () => {
    expect(shortcutFor(key({ key: 'j' }), true)).toBeNull()
    expect(shortcutFor(key({ key: 'k' }), true)).toBeNull()
  })

  // Ctrl+W is readline's delete-word-backward. It used to open the new-worktree
  // dialog; with that gone the app must stop intercepting it so the shell gets it.
  it.each([true, false])('leaves Ctrl+W to the shell (isMac=%s)', isMac => {
    expect(shortcutFor(key({ key: 'w', control: true }), isMac)).toBeNull()
  })

  it('ignores Cmd+W, which closes the window on macOS', () => {
    expect(shortcutFor(key({ key: 'w', meta: true }), true)).toBeNull()
  })

  it('ignores bare W without Ctrl', () => {
    expect(shortcutFor(key({ key: 'w' }), true)).toBeNull()
  })
})

describe('Ctrl+U marks unread, in the same family as Ctrl+J/Ctrl+K', () => {
  it('fires on a held Control plus U, which is what a remapped Caps Lock sends', () => {
    expect(shortcutFor(key({ key: 'u', control: true }), true)).toBe('markUnread')
    expect(shortcutFor(key({ key: 'u', code: 'KeyU', control: true }), false)).toBe('markUnread')
  })

  it('fires when Ctrl+U arrives as its control character', () => {
    expect(shortcutFor(key({ key: '\u0015', control: true }), true)).toBe('markUnread')
  })

  it('leaves a bare U alone, so typing in the terminal is untouched', () => {
    expect(shortcutFor(key({ key: 'u' }), true)).toBeNull()
  })

  it('leaves Cmd+U alone', () => {
    expect(shortcutFor(key({ key: 'u', meta: true, control: true }), true)).toBeNull()
  })

  it('swallows it, so the shell never sees the kill-line', () => {
    const r = resolveKey(key({ key: 'u', control: true }), true, null, 1000)
    expect(r).toEqual({ action: 'markUnread', swallow: true, prefixAt: null })
  })
})

describe('the Ctrl+S chord', () => {
  const ctrlS = key({ key: 's', control: true })
  const u = key({ key: 'u' })

  it('arms on Ctrl+S without swallowing it, so terminal chords still work', () => {
    const r = resolveKey(ctrlS, true, null, 1000)
    expect(r).toEqual({ action: null, swallow: false, prefixAt: 1000 })
  })

  it('completes Ctrl+S then U, and swallows the U', () => {
    const r = resolveKey(u, true, 1000, 1100)
    expect(r).toEqual({ action: 'markUnread', swallow: true, prefixAt: null })
  })

  it('accepts an uppercase U', () => {
    expect(resolveKey(key({ key: 'U' }), true, 1000, 1100).action).toBe('markUnread')
  })

  it('completes with Ctrl still held, which is how the chord is actually typed', () => {
    const r = resolveKey(key({ key: 'u', control: true }), true, 1000, 1100)
    expect(r).toEqual({ action: 'markUnread', swallow: true, prefixAt: null })
  })

  // With Ctrl held, `key` is whatever the platform decided the combination
  // produces; only `code` is dependable. All three spellings must work.
  it('completes when Ctrl+U arrives as the control character', () => {
    expect(resolveKey(key({ key: '\u0015', control: true }), true, 1000, 1100).action)
      .toBe('markUnread')
  })

  it('completes on the physical key code, whatever key says', () => {
    const r = resolveKey(key({ key: '\u0015', code: 'KeyU', control: true }), true, 1000, 1100)
    expect(r.action).toBe('markUnread')
  })

  it('arms on a Ctrl+S that arrives as the control character', () => {
    expect(isChordPrefix(key({ key: '\u0013', control: true }))).toBe(true)
    expect(isChordPrefix(key({ key: 'x', code: 'KeyS', control: true }))).toBe(true)
  })

  it('trusts code over key, so Ctrl+I is not mistaken for the chord', () => {
    expect(isChordPrefix(key({ key: 's', code: 'KeyI', control: true }))).toBe(false)
  })

  it('leaves a held-Ctrl second key that is not U alone', () => {
    const r = resolveKey(key({ key: 'e', control: true }), true, 1000, 1100)
    expect(r.action).toBeNull()
    expect(r.swallow).toBe(false)
  })

  it('still navigates on Ctrl+J typed after the prefix, rather than eating it', () => {
    const r = resolveKey(key({ key: 'j', control: true }), true, 1000, 1100)
    expect(r).toEqual({ action: 'next', swallow: true, prefixAt: null })
  })

  it('leaves every other second key alone, so Ctrl+S then E still reaches the terminal', () => {
    const r = resolveKey(key({ key: 'e' }), true, 1000, 1100)
    expect(r).toEqual({ action: null, swallow: false, prefixAt: null })
  })

  it('does nothing on a bare U with no prefix armed', () => {
    expect(resolveKey(u, true, null, 1000).action).toBeNull()
  })

  it('expires the prefix, so a U typed much later is just a U', () => {
    const r = resolveKey(u, true, 1000, 1000 + CHORD_TIMEOUT_MS + 1)
    expect(r).toEqual({ action: null, swallow: false, prefixAt: null })
  })

  it('ignores a Cmd- or Alt-modified U, which is someone else\'s binding', () => {
    expect(resolveKey(key({ key: 'u', meta: true }), true, 1000, 1100).action).toBeNull()
    expect(resolveKey(key({ key: 'u', alt: true }), true, 1000, 1100).action).toBeNull()
  })

  it('re-arms rather than going stale on a second Ctrl+S', () => {
    expect(resolveKey(ctrlS, true, 1000, 1200).prefixAt).toBe(1200)
  })

  // Caps Lock remapped to "Control when held, Ctrl+S when tapped alone" emits
  // the synthetic Ctrl+S and then a real Control keyDown, because the physical
  // key is still down. That must not count as the second key.
  it('survives the Control keyDown that follows a remapped Caps Lock tap', () => {
    const ctrlDown = key({ key: 'Control', code: 'ControlLeft', control: true })
    expect(resolveKey(ctrlDown, true, 1000, 1010).prefixAt).toBe(1000)
    const ctrlUp = key({ key: 'Control', code: 'ControlLeft', type: 'keyUp' })
    expect(resolveKey(ctrlUp, true, 1000, 1020).prefixAt).toBe(1000)
  })

  it('completes the whole Caps Lock sequence end to end', () => {
    let at: number | null = null
    const feed = (k: Partial<KeyInput>, now: number) => {
      const r = resolveKey(key(k), true, at, now)
      at = r.prefixAt
      return r
    }
    feed({ key: 'Control', code: 'ControlLeft', control: true }, 1000)
    feed({ key: 's', code: 'KeyS', control: true }, 1010)
    expect(at).toBe(1010)
    feed({ key: 's', code: 'KeyS', control: true, type: 'keyUp' }, 1020)
    feed({ key: 'Control', code: 'ControlLeft', type: 'keyUp' }, 1030)
    feed({ key: 'Control', code: 'ControlLeft', control: true }, 1040)
    expect(at).toBe(1010) // still armed
    expect(feed({ key: 'u', code: 'KeyU' }, 1200).action).toBe('markUnread')
  })

  it('knows a modifier press from a real key', () => {
    expect(isModifierKey(key({ key: 'Control' }))).toBe(true)
    expect(isModifierKey(key({ key: 'Shift' }))).toBe(true)
    expect(isModifierKey(key({ key: 'u' }))).toBe(false)
  })

  it('survives the key-up of the prefix itself', () => {
    const up = key({ key: 's', control: true, type: 'keyUp' })
    expect(resolveKey(up, true, 1000, 1010).prefixAt).toBe(1000)
  })

  it('still runs the plain shortcuts, and swallows those', () => {
    const r = resolveKey(key({ key: 'ArrowDown', meta: true }), true, null, 1000)
    expect(r).toEqual({ action: 'next', swallow: true, prefixAt: null })
  })

  it('recognizes only an unmodified Ctrl+S as the prefix', () => {
    expect(isChordPrefix(ctrlS)).toBe(true)
    expect(isChordPrefix(key({ key: 's', control: true, shift: true }))).toBe(false)
    expect(isChordPrefix(key({ key: 's', control: true, meta: true }))).toBe(false)
    expect(isChordPrefix(key({ key: 's' }))).toBe(false)
  })
})
