import { isCommandGroup, type RepoCommand, type RepoCommandEntry } from '@shared/ipc-types'

// The rules the commands editor applies to a draft, kept out of the component
// so they can be checked directly. The split that matters is between what the
// parser would silently drop when the file is read back (fatal — the editor
// blocks the save rather than let a button vanish) and what is merely worth
// mentioning (said out loud, saved anyway).

export function problems(entries: RepoCommandEntry[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (isCommandGroup(entry)) {
      if (!entry.label.trim()) out.push('A group needs a name.')
      if (!entry.commands.length) out.push(`"${entry.label || 'Untitled group'}" has no commands.`)
      out.push(...problems(entry.commands))
    } else {
      if (!entry.label.trim()) out.push('A command needs a label.')
      else if (!entry.run.trim()) out.push(`"${entry.label}" has no command to run.`)
    }
  }
  return out
}

// Advisory only. Two buttons reading the same is hard to tell apart, but the
// same command loose and inside a group is a reasonable thing to want — and the
// panel identifies buttons by position, so duplicates run correctly.
export function duplicateLabels(entries: RepoCommandEntry[]): string[] {
  const flat = entries.flatMap(e => (isCommandGroup(e) ? e.commands : [e])).map(c => c.label.trim())
  return [...new Set(flat.filter((l, i) => l && flat.indexOf(l) !== i))]
}

// Optional keys are omitted rather than written as their default, so the file
// stays as small as what you'd have typed by hand.
export function clean(entries: RepoCommandEntry[]): RepoCommandEntry[] {
  const cleanCommand = (c: RepoCommand): RepoCommand => ({
    label: c.label.trim(),
    run: c.run.trim(),
    ...(c.cwd === 'repo' && { cwd: 'repo' as const }),
    ...(c.width === 'full' && { width: 'full' as const }),
    ...(c.shell && { shell: true })
  })
  return entries.map(e => (isCommandGroup(e)
    ? { label: e.label.trim(), commands: e.commands.map(cleanCommand), ...(e.open && { open: true }) }
    : cleanCommand(e)))
}

// Moving is by one step: the list is short, and a drag surface would be a lot
// of machinery for reordering half a dozen buttons.
export function move<T>(list: T[], from: number, delta: number): T[] {
  const to = from + delta
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}
