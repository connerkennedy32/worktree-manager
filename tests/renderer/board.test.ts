import { describe, it, expect } from 'vitest'
import { branchForTask, repoInitials, slugifyTitle } from '../../src/renderer/state/board'

describe('branch names from task titles', () => {
  it('kebab-cases a title and drops punctuation', () => {
    expect(slugifyTitle('Fix the import crash!')).toBe('fix-the-import-crash')
    expect(slugifyTitle("Don't retry PDFs")).toBe('dont-retry-pdfs')
    expect(slugifyTitle('  Openly / Symbility  ')).toBe('openly-symbility')
  })

  it('never ends on a separator, even after truncation', () => {
    const long = slugifyTitle('a'.repeat(40) + ' and then some more words here')
    expect(long.length).toBeLessThanOrEqual(48)
    expect(long.endsWith('-')).toBe(false)
  })

  it('applies a prefix, tolerating a trailing slash on it', () => {
    expect(branchForTask('Retry Openly PDFs', 'ck')).toBe('ck/retry-openly-pdfs')
    expect(branchForTask('Retry Openly PDFs', 'ck/')).toBe('ck/retry-openly-pdfs')
    expect(branchForTask('Retry Openly PDFs')).toBe('retry-openly-pdfs')
  })

  it('has nothing to offer for a title with no letters in it', () => {
    expect(branchForTask('!!!', 'ck')).toBe('')
  })
})

describe('repo rail initials', () => {
  it('takes initials from a multi-part name', () => {
    expect(repoInitials('worktree-manager')).toBe('WM')
    expect(repoInitials('partner_integrations')).toBe('PI')
  })

  it('falls back to the first two letters of a single word', () => {
    expect(repoInitials('remi')).toBe('RE')
  })

  it('has nothing to show for an empty name', () => {
    expect(repoInitials('')).toBe('')
  })
})
