import type { AgentReport } from './agent-status'

export interface Worktree {
  path: string
  branch: string        // e.g. "feat-auth" or "(detached)"
  head: string          // short sha
  isMain: boolean
  repoName: string
  locked?: boolean      // worktree marked locked via `git worktree lock`
}

export interface FileChange {
  path: string          // repo-relative
  index: string         // porcelain XY: staged status char
  working: string       // porcelain XY: working status char
  changeCount?: number
}

export interface LineStat { add: number; del: number }

export interface WorktreeStatus {
  worktreePath: string
  files: FileChange[]
  changeCount: number
  // Line counts keyed by path, per side of the split. Untracked files are folded
  // into `unstaged` (all additions). Missing entries mean no line-level diff.
  staged: Record<string, LineStat>
  unstaged: Record<string, LineStat>
}

export interface DiffFile {
  path: string
  oldPath: string
  hunks: unknown[]      // parsed by react-diff-view on renderer
  rawPatch: string      // full unified diff text for this file
  staged: boolean
}

export interface CommittedFile {
  path: string          // repo-relative
  code: string          // name-status letter: M A D R etc.
  oldPath?: string      // set for renames (code 'R')
  add?: number          // lines added vs base
  del?: number          // lines removed vs base
}

// Push returns an outcome rather than throwing: Electron wraps a thrown
// main-process error, which would bury git's rejection message in framing.
export type PushOutcome = { ok: true } | { ok: false; message: string }

// Unlike a push, a successful sync still has something to say — whether it
// merged anything, and how much — so success carries a summary too.
export type SyncOutcome = { ok: boolean; message: string }

export interface CommittedChanges {
  baseBranch: string    // branch of the repo's main worktree; '' when unresolvable
  files: CommittedFile[]
}

export interface StageRequest { worktreePath: string; patch: string; reverse?: boolean }
export interface FileDiffRequest {
  worktreePath: string
  path: string
  staged: boolean
  untracked: boolean
  baseRef?: string      // when set, diff <baseRef>...HEAD instead of the working tree
}
export interface StagePathRequest { worktreePath: string; path: string; unstage: boolean }
export interface DiscardPathRequest { worktreePath: string; path: string }
export interface ReadFileRequest { worktreePath: string; path: string }
export interface WriteFileRequest { worktreePath: string; path: string; content: string }
export interface CommitRequest { worktreePath: string; message: string }
export interface NewWorktreeRequest { repoPath: string; branch: string; createBranch: boolean }

export interface Api {
  listRepos(): Promise<string[]>
  addRepo(path: string): Promise<string[]>
  removeRepo(path: string): Promise<string[]>
  pickRepo(): Promise<string[]>
  // Custom worktree tab names keyed by path. Persisted in the main process so
  // they survive a renderer localStorage clear. setName with an empty string
  // clears the override.
  listNames(): Promise<Record<string, string>>
  setName(worktreePath: string, name: string): Promise<Record<string, string>>
  // Background backdrop. Files live in userData/backgrounds and are managed from
  // the Background app menu; the renderer only reads the current selection (a
  // bare filename, or '' for the built-in default) and re-reads it when the menu
  // changes it. Files are served via the wtm-bg:// protocol.
  getSelectedBackground(): Promise<string>
  onBackgroundChanged(cb: () => void): () => void
  listWorktrees(repoPath: string): Promise<Worktree[]>
  createWorktree(req: NewWorktreeRequest): Promise<Worktree[]>
  removeWorktree(worktreePath: string, force: boolean): Promise<Worktree[]>
  getStatus(worktreePath: string): Promise<WorktreeStatus>
  getDiff(worktreePath: string): Promise<DiffFile[]>
  getCommittedFiles(worktreePath: string): Promise<CommittedChanges>
  getFileDiff(req: FileDiffRequest): Promise<string>
  readFile(req: ReadFileRequest): Promise<string>
  writeFile(req: WriteFileRequest): Promise<void>
  stage(req: StageRequest): Promise<void>
  stagePath(req: StagePathRequest): Promise<void>
  stageAll(worktreePath: string): Promise<void>
  discardPath(req: DiscardPathRequest): Promise<void>
  commit(req: CommitRequest): Promise<void>
  // Commits this worktree has that the remote doesn't. Fetched per worktree
  // rather than carried on WorktreeStatus — see the push-button design spec.
  getPendingCount(worktreePath: string): Promise<number>
  push(worktreePath: string): Promise<PushOutcome>
  // Fetch trunk and merge it into this worktree's branch.
  syncWithTrunk(worktreePath: string): Promise<SyncOutcome>
  // Live output of the git commands a branch action runs, so the panel can show
  // what a terminal would. Chunks arrive as git writes them.
  onGitOutput(cb: (worktreePath: string, chunk: string) => void): () => void
  // Electron's clipboard rather than navigator.clipboard: the packaged app loads
  // the renderer from file://, which is not a secure context, so the web
  // clipboard API isn't there at all.
  copyText(text: string): void
  openLazygit(worktreePath: string): void
  // Open the worktree folder in VS Code via the `code` CLI. With `file` (a
  // worktree-relative path) that file is opened too, inside the worktree window.
  openInEditor(worktreePath: string, file?: string): void
  // Open a worktree-relative file in the OS default browser (used for .html
  // previews from the diff modal).
  openInBrowser(worktreePath: string, file: string): void
  // URL that renders a worktree-relative file inside the app (wtm-preview://),
  // used by the diff modal's in-pane HTML preview. Relative assets in the page
  // resolve against the worktree, as they would in a browser.
  previewUrl(worktreePath: string, file: string): Promise<string>
  // Absolute path of a dropped File. Uses Electron's webUtils under the hood
  // since renderer File objects don't expose a filesystem path on their own.
  getPathForFile(file: File): string
  // terminal
  listTerminals(): Promise<string[]>
  termStart(worktreePath: string): void
  termReset(worktreePath: string): Promise<void>
  termInput(worktreePath: string, data: string): void
  termResize(worktreePath: string, cols: number, rows: number): void
  // Brings the app window to the foreground (e.g. when a file drag enters it),
  // so drops land without first clicking the app to focus it.
  focusWindow(): void
  onTermData(cb: (worktreePath: string, data: string) => void): () => void
  onStatusChanged(cb: (worktreePath: string) => void): () => void
  getAgentStatuses(): Promise<Record<string, AgentReport>>
  onAgentStatus(cb: (worktreePath: string, report: AgentReport) => void): () => void
  onMenuResetTerminal(cb: () => void): () => void
  onMenuNewWorktree(cb: () => void): () => void
  onMenuSelectPrev(cb: () => void): () => void
  onMenuSelectNext(cb: () => void): () => void
}

// Backdrops bundled with the app, offered in the Background menu alongside any
// user-added files. Selection is stored as `builtin:<id>`; '' means no backdrop
// (blank). The renderer maps each id to its imported asset.
export const BUILTIN_BACKGROUNDS = [
  { id: 'voyage', label: 'Voyage (image)' },
  { id: 'blackhole', label: 'Black hole (video)' }
] as const
export type BuiltinBackgroundId = typeof BUILTIN_BACKGROUNDS[number]['id']

export const IPC = {
  listRepos: 'repos:list', addRepo: 'repos:add', removeRepo: 'repos:remove', pickRepo: 'repos:pick',
  listNames: 'names:list', setName: 'names:set',
  getSelectedBackground: 'bg:get', backgroundChanged: 'bg:changed',
  listWorktrees: 'wt:list', createWorktree: 'wt:create', removeWorktree: 'wt:remove',
  getStatus: 'wt:status', getDiff: 'diff:get', getFileDiff: 'diff:file',
  readFile: 'file:read', writeFile: 'file:write',
  getCommittedFiles: 'diff:committed',
  stage: 'diff:stage', stagePath: 'diff:stagePath', stageAll: 'diff:stageAll',
  discardPath: 'diff:discardPath', commit: 'diff:commit',
  pendingCount: 'push:pending', push: 'push:run', syncWithTrunk: 'sync:trunk',
  gitOutput: 'git:output',
  openLazygit: 'term:lazygit',
  openInEditor: 'editor:open',
  openInBrowser: 'browser:open',
  previewUrl: 'preview:url',
  listTerminals: 'term:list',
  termStart: 'term:start', termReset: 'term:reset', termInput: 'term:input', termResize: 'term:resize',
  termData: 'term:data', statusChanged: 'wt:statusChanged',
  focusWindow: 'win:focus',
  getAgentStatuses: 'agent:list', agentStatus: 'agent:status',
  menuResetTerminal: 'menu:resetTerminal', menuNewWorktree: 'menu:newWorktree',
  menuSelectPrev: 'menu:selectPrev', menuSelectNext: 'menu:selectNext'
} as const
