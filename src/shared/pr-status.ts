// PR state as shown in the sidebar. 'none' means the branch has no pull
// request at all — the row then renders no dot, rather than a neutral one.
export type PrState =
  | 'none' | 'draft' | 'review' | 'changesRequested' | 'approved' | 'merged' | 'closed'

export interface PrStatus {
  state: PrState
  number?: number
  url?: string
}

// The subset of `gh pr view --json ...` we ask for. `reviewDecision` is '' when
// the repo requires no review, and gh may add values we don't know about.
export interface RawPr {
  number: number
  url: string
  isDraft: boolean
  state: string           // OPEN | CLOSED | MERGED
  reviewDecision: string  // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
}

export const PR_STATE_LABEL: Record<PrState, string> = {
  none: 'No pull request',
  draft: 'Draft',
  review: 'In review',
  changesRequested: 'Changes requested',
  approved: 'Approved',
  merged: 'Merged',
  closed: 'Closed'
}

// Merged/closed outrank draft because the PR's life is over either way; draft
// outranks any review decision because a stray approval on a draft doesn't make
// it reviewable. Anything unrecognized lands on 'review', the neutral open state.
export function derivePrState(raw: RawPr): PrState {
  if (raw.state === 'MERGED') return 'merged'
  if (raw.state === 'CLOSED') return 'closed'
  if (raw.isDraft) return 'draft'
  if (raw.reviewDecision === 'APPROVED') return 'approved'
  if (raw.reviewDecision === 'CHANGES_REQUESTED') return 'changesRequested'
  return 'review'
}
