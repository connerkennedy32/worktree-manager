import chokidar, { type FSWatcher } from 'chokidar'

// Directories that are huge and/or irrelevant to git status. Watching these
// (especially node_modules) makes chokidar crawl tens of thousands of paths,
// which never settles quickly and stalls the main event loop — starving the
// terminal IPC and causing multi-second typing lag.
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'out', 'dist', 'build', '.worktrees',
  '.next', '.cache', '.turbo', 'coverage', '.venv', '__pycache__', 'target', 'vendor'
])

export function isIgnoredPath(p: string): boolean {
  // Match any path segment against the ignore set (cross-platform separators).
  const segments = p.split(/[/\\]/)
  return segments.some(seg => IGNORED_DIRS.has(seg))
}

export class WatcherManager {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()

  watch(worktreePath: string, onChange: () => void, headFile?: string) {
    if (this.watchers.has(worktreePath)) return
    const paths = headFile ? [worktreePath, headFile] : [worktreePath]
    const w = chokidar.watch(paths, {
      // Watch the working tree (skipping heavy dirs) plus the git HEAD file
      // (which lives under .git and would otherwise be ignored).
      ignored: (p: string) => p === headFile ? false : isIgnoredPath(p),
      ignoreInitial: true,
      persistent: true,
      depth: 8
    })
    const fire = () => {
      clearTimeout(this.timers.get(worktreePath))
      this.timers.set(worktreePath, setTimeout(onChange, 300))
    }
    w.on('all', fire)
    this.watchers.set(worktreePath, w)
  }
  unwatch(worktreePath: string) {
    this.watchers.get(worktreePath)?.close()
    this.watchers.delete(worktreePath)
    clearTimeout(this.timers.get(worktreePath))
    this.timers.delete(worktreePath)
  }
  unwatchAll() { for (const [, w] of this.watchers) w.close(); this.watchers.clear() }
}
