import { describe, it, expect } from 'vitest'
import { isIgnoredPath } from '../src/main/watcher'

describe('isIgnoredPath', () => {
  it('ignores node_modules, .git, and build output', () => {
    expect(isIgnoredPath('/repo/node_modules/foo/index.js')).toBe(true)
    expect(isIgnoredPath('/repo/.git/HEAD')).toBe(true)
    expect(isIgnoredPath('/repo/out/main/index.js')).toBe(true)
    expect(isIgnoredPath('/repo/dist/bundle.js')).toBe(true)
  })
  it('does not ignore normal source files', () => {
    expect(isIgnoredPath('/repo/src/app.ts')).toBe(false)
    expect(isIgnoredPath('/repo/README.md')).toBe(false)
  })
})
