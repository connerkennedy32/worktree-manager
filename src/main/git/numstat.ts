import type { LineStat } from '@shared/ipc-types'

// Resolve the post-change path from a numstat path field, which encodes renames
// either as "old => new" or "pre/{old => new}/post". Mirrors how status.ts and
// committed.ts settle on the new path so counts key by the same path as the rows.
function resolvePath(field: string): string {
  const braced = field.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\//g, '/')
  if (field.includes(' => ')) return field.split(' => ')[1]
  return field
}

// Parse `git diff --numstat` output into a path -> {add, del} map. Binary files
// report "-" for both counts; we treat those as zero so the row still renders.
export function parseNumstat(raw: string): Record<string, LineStat> {
  const out: Record<string, LineStat> = {}
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const add = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0
    const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0
    out[resolvePath(parts[2])] = { add, del }
  }
  return out
}
