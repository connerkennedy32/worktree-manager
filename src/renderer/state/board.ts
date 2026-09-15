// Turning a task title into a branch name. Kept out of the component so the
// rule is testable without a DOM — and visible, since the start pane shows the
// branch it is about to create and lets the user overrule it.

// Trailing/leading separators are trimmed rather than collapsed into the name,
// so "Fix the import crash!" reads as a branch and not as punctuation.
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, '')        // don't turn "don't" into "don-t"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

// The branch a task would get. `prefix` is the user's own convention (ck/, a
// Linear key, nothing at all); an empty title yields an empty branch, which the
// start pane treats as "you have to type one".
export function branchForTask(title: string, prefix = ''): string {
  const slug = slugifyTitle(title)
  if (!slug) return ''
  return prefix ? `${prefix.replace(/\/+$/, '')}/${slug}` : slug
}

// The two characters the repo rail puts on a square. Initials where the name
// has parts to take them from ("worktree-manager" → "WM"), else the first two
// letters ("remi" → "RE"); the square carries the full name as its tooltip, so
// this only has to be recognizable, not unique.
export function repoInitials(name: string): string {
  const parts = name.split(/[-_.\s]+/).filter(Boolean)
  const letters = parts.length > 1
    ? parts.slice(0, 2).map(p => p[0]).join('')
    : (parts[0] ?? '').slice(0, 2)
  return letters.toUpperCase()
}
