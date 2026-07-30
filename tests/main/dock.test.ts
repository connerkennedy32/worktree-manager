import { describe, it, expect } from 'vitest'
import { badgeText, SPINNER_LENGTH } from '../../src/main/dock'
import type { RawStatus } from '../../src/shared/agent-status'

describe('badgeText', () => {
  const cases: [string, RawStatus[], string][] = [
    ['nothing live', [], ''],
    ['only finished turns', ['done', 'failed'], ''],
    ['one working agent', ['working'], '⠋'],
    ['several working agents look the same as one', ['working', 'done', 'working'], '⠋'],
    ['permission outranks working', ['working', 'permission'], '?']
  ]
  it.each(cases)('%s -> %j', (_name, statuses, expected) => {
    expect(badgeText(statuses, 0)).toBe(expected)
  })

  it('flashes a checkmark over the spinner, but never over a permission prompt', () => {
    expect(badgeText(['working'], 0, true)).toBe('✓')
    expect(badgeText([], 0, true)).toBe('✓')
    expect(badgeText(['working', 'permission'], 0, true)).toBe('?')
  })

  it('advances through distinct frames and wraps', () => {
    const cycle = Array.from({ length: SPINNER_LENGTH }, (_, i) => badgeText(['working'], i))
    expect(new Set(cycle).size).toBe(SPINNER_LENGTH)
    expect(badgeText(['working'], SPINNER_LENGTH)).toBe(cycle[0])
  })
})
