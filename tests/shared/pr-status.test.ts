import { describe, it, expect } from 'vitest'
import { derivePrState, graphiteUrl, PR_STATE_LABEL, type RawPr } from '@shared/pr-status'

const raw = (over: Partial<RawPr> = {}): RawPr =>
  ({ number: 1, url: 'u', isDraft: false, state: 'OPEN', reviewDecision: '', ...over })

describe('derivePrState', () => {
  it('reports a merged PR as merged even when it was a draft', () => {
    expect(derivePrState(raw({ state: 'MERGED', isDraft: true }))).toBe('merged')
  })

  it('reports a closed PR as closed', () => {
    expect(derivePrState(raw({ state: 'CLOSED' }))).toBe('closed')
  })

  it('reports a draft as draft even when approved', () => {
    expect(derivePrState(raw({ isDraft: true, reviewDecision: 'APPROVED' }))).toBe('draft')
  })

  it('reports an approved open PR as approved', () => {
    expect(derivePrState(raw({ reviewDecision: 'APPROVED' }))).toBe('approved')
  })

  it('reports a changes-requested PR as changesRequested', () => {
    expect(derivePrState(raw({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('changesRequested')
  })

  it('falls back to review for REVIEW_REQUIRED, empty, and unknown decisions', () => {
    expect(derivePrState(raw({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe('review')
    expect(derivePrState(raw({ reviewDecision: '' }))).toBe('review')
    expect(derivePrState(raw({ reviewDecision: 'SOMETHING_NEW' }))).toBe('review')
  })

  it('falls back to review for an unrecognized state string', () => {
    expect(derivePrState(raw({ state: 'WEIRD' }))).toBe('review')
  })

  it('labels every state', () => {
    expect(PR_STATE_LABEL.changesRequested).toBe('Changes requested')
    expect(PR_STATE_LABEL.none).toBe('No pull request')
  })
})

describe('graphiteUrl', () => {
  it('rewrites a github PR url to the graphite one', () => {
    expect(graphiteUrl('https://github.com/acme/widgets/pull/123'))
      .toBe('https://app.graphite.dev/github/pr/acme/widgets/123')
  })

  it('ignores a trailing path or query on the github url', () => {
    expect(graphiteUrl('https://github.com/acme/widgets/pull/123/files?w=1'))
      .toBe('https://app.graphite.dev/github/pr/acme/widgets/123')
  })

  it('leaves anything that is not a github.com PR url alone', () => {
    for (const url of [
      'https://ghe.corp.example/acme/widgets/pull/9',
      'https://github.com/acme/widgets/issues/9',
      'https://github.com/acme/widgets',
      ''
    ]) expect(graphiteUrl(url)).toBe(url)
  })
})
