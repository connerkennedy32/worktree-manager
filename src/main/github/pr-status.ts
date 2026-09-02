import { derivePrState, type PrStatus, type RawPr } from '@shared/pr-status'
import { ghMissing, ghUnauthenticated, runGh, type GhRunner } from './gh'
import { isLandedInTrunk } from '../git/landed'
import type { PrRefreshResult } from '@shared/ipc-types'

const FIELDS = 'number,url,isDraft,state,reviewDecision'

// Injectable so the tests can exercise the closed-but-landed rewrite without a
// real repo on disk; production always uses the git-backed check.
export type LandedCheck = (worktreePath: string) => Promise<boolean>

// gh says this when the branch simply has no PR — an ordinary answer, not a
// failure, so it maps to a real 'none' status that gets cached like any other.
const NO_PR = /no (open )?pull requests? found/i

// null means "we learned nothing" — the caller keeps whatever it had cached
// rather than blanking a dot because the network hiccuped.
export async function fetchPrStatus(
  worktreePath: string, run: GhRunner = runGh, landed: LandedCheck = isLandedInTrunk
): Promise<PrStatus | null> {
  const res = await run(['pr', 'view', '--json', FIELDS], worktreePath)
  if (!res.ok) return NO_PR.test(res.stderr) ? { state: 'none' } : null
  try {
    const raw = JSON.parse(res.stdout) as RawPr
    const state = derivePrState(raw)
    // GitHub calls a Graphite-landed PR closed, because the commits that reached
    // trunk were rebased and carry different shas. Only 'closed' is worth
    // re-checking against git — every other state is GitHub's to know.
    const real = state === 'closed' && await landed(worktreePath) ? 'merged' : state
    return { state: real, number: raw.number, url: raw.url }
  } catch {
    return null
  }
}

const CONCURRENCY = 6

// A tiny worker pool rather than Promise.all: a user with twenty worktrees
// would otherwise fire twenty gh processes, each opening its own connection.
async function pool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await work(items[i++])
  })
  await Promise.all(workers)
}

// A missing or unauthenticated gh is one problem with the machine, not one per
// worktree, so it's reported once. Whatever did succeed still comes back — a
// per-repo auth failure (SAML SSO, a private repo) must not blank the rest.
export async function refreshAll(
  paths: string[], run: GhRunner = runGh, landed: LandedCheck = isLandedInTrunk
): Promise<PrRefreshResult> {
  const statuses: Record<string, PrStatus> = {}
  let error: string | undefined

  const probing: GhRunner = async (args, cwd) => {
    const res = await run(args, cwd)
    if (!res.ok && !NO_PR.test(res.stderr)) {
      if (ghMissing(res.stderr)) error ??= 'GitHub CLI (gh) not found. Install it to see PR status.'
      else if (ghUnauthenticated(res.stderr)) error ??= 'GitHub CLI is not authenticated. Run `gh auth login`.'
    }
    return res
  }

  await pool(paths, CONCURRENCY, async p => {
    const s = await fetchPrStatus(p, probing, landed)
    if (s) statuses[p] = s
  })

  return error ? { statuses, error } : { statuses }
}
