import { useEffect, useMemo, useState } from 'react'
import type { CommittedChanges, WorktreeStatus } from '@shared/ipc-types'
import { useStore, type DiffTarget } from '../state/store'

export type SectionId = 'staged' | 'unstaged' | 'committed'

export interface Row extends DiffTarget {
  code: string // status letter: M A D R ? etc.
}

export const codeColor = (c: string) =>
  c === 'A' || c === '?' ? '#6a9955' : c === 'D' ? '#c94a4a' : '#c9a26a'

// Build the file list cheaply from `git status` — no diffs computed here. A file
// staged and then modified again yields two rows, one per side of the split.
export function buildWorkingRows(status?: WorktreeStatus): Row[] {
  if (!status) return []
  const out: Row[] = []
  for (const f of status.files) {
    const untracked = f.index === '?' && f.working === '?'
    if (untracked) {
      out.push({ key: f.path + ':u', path: f.path, staged: false, untracked: true, committed: false, code: '?' })
      continue
    }
    if (f.index !== ' ' && f.index !== '?') {
      out.push({ key: f.path + ':s', path: f.path, staged: true, untracked: false, committed: false, code: f.index })
    }
    if (f.working !== ' ' && f.working !== '?') {
      out.push({ key: f.path + ':w', path: f.path, staged: false, untracked: false, committed: false, code: f.working })
    }
  }
  return out
}

// Which file the diff modal should show, given the rows currently listed.
// Staging flips a row's key (a.ts:w -> a.ts:s), so a vanished key does not mean
// a vanished file — follow the path to its new side of the split, and close only
// when the file is really gone (committed, reverted, checked out away).
export function reconcileTarget(open: DiffTarget, rows: Row[]): DiffTarget | null {
  if (rows.length === 0) return open        // list still loading — hold
  if (rows.some(r => r.key === open.key)) return open
  return rows.find(r => r.path === open.path) ?? null
}

export function buildCommittedRows(committed: CommittedChanges | null): Row[] {
  return (committed?.files ?? []).map(f => ({
    key: f.path + ':c', path: f.path, staged: false, untracked: false, committed: true, code: f.code
  }))
}

// Shared by DiffPanel and DiffModal so the two lists can never drift apart.
export function useChangedFiles(selected?: string) {
  const refreshStatus = useStore(s => s.refreshStatus)
  const status = useStore(s => (selected ? s.statuses[selected] : undefined))
  const [committed, setCommitted] = useState<CommittedChanges | null>(null)

  useEffect(() => {
    if (!selected) return
    setCommitted(null)
    refreshStatus(selected)
  }, [selected])

  // Refetch alongside every status change: a commit empties the working tree but
  // grows the committed list, so the list would otherwise just go blank.
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    window.api.getCommittedFiles(selected).then(c => { if (!cancelled) setCommitted(c) })
    return () => { cancelled = true }
  }, [selected, status])

  const rows = useMemo(() => buildWorkingRows(status), [status])
  const committedRows = useMemo(() => buildCommittedRows(committed), [committed])

  return {
    stagedRows: useMemo(() => rows.filter(r => r.staged), [rows]),
    unstagedRows: useMemo(() => rows.filter(r => !r.staged), [rows]),
    committedRows,
    committed,
    // Committed files aren't pending work — they must not inflate these counts.
    stagedCount: rows.filter(r => r.staged).length,
    total: rows.length
  }
}
