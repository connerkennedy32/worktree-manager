export interface Worktree {
  path: string
  branch: string        // e.g. "feat-auth" or "(detached)"
  head: string          // short sha
  isMain: boolean
  repoName: string
}

export interface FileChange {
  path: string          // repo-relative
  index: string         // porcelain XY: staged status char
  working: string       // porcelain XY: working status char
  changeCount?: number
}

export interface WorktreeStatus {
  worktreePath: string
  files: FileChange[]
  changeCount: number
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
}

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
export interface CommitRequest { worktreePath: string; message: string }
export interface NewWorktreeRequest { repoPath: string; branch: string; createBranch: boolean }

export interface Api {
  listRepos(): Promise<string[]>
  addRepo(path: string): Promise<string[]>
  removeRepo(path: string): Promise<string[]>
  pickRepo(): Promise<string[]>
  listWorktrees(repoPath: string): Promise<Worktree[]>
  createWorktree(req: NewWorktreeRequest): Promise<Worktree[]>
  removeWorktree(worktreePath: string, force: boolean): Promise<Worktree[]>
  getStatus(worktreePath: string): Promise<WorktreeStatus>
  getDiff(worktreePath: string): Promise<DiffFile[]>
  getCommittedFiles(worktreePath: string): Promise<CommittedChanges>
  getFileDiff(req: FileDiffRequest): Promise<string>
  stage(req: StageRequest): Promise<void>
  stagePath(req: StagePathRequest): Promise<void>
  commit(req: CommitRequest): Promise<void>
  openLazygit(worktreePath: string): void
  // terminal
  listTerminals(): Promise<string[]>
  termStart(worktreePath: string): void
  termReset(worktreePath: string): Promise<void>
  termInput(worktreePath: string, data: string): void
  termResize(worktreePath: string, cols: number, rows: number): void
  onTermData(cb: (worktreePath: string, data: string) => void): () => void
  onStatusChanged(cb: (worktreePath: string) => void): () => void
  onMenuResetTerminal(cb: () => void): () => void
  onMenuNewWorktree(cb: () => void): () => void
}

export const IPC = {
  listRepos: 'repos:list', addRepo: 'repos:add', removeRepo: 'repos:remove', pickRepo: 'repos:pick',
  listWorktrees: 'wt:list', createWorktree: 'wt:create', removeWorktree: 'wt:remove',
  getStatus: 'wt:status', getDiff: 'diff:get', getFileDiff: 'diff:file',
  getCommittedFiles: 'diff:committed',
  stage: 'diff:stage', stagePath: 'diff:stagePath', commit: 'diff:commit',
  openLazygit: 'term:lazygit',
  listTerminals: 'term:list',
  termStart: 'term:start', termReset: 'term:reset', termInput: 'term:input', termResize: 'term:resize',
  termData: 'term:data', statusChanged: 'wt:statusChanged',
  menuResetTerminal: 'menu:resetTerminal', menuNewWorktree: 'menu:newWorktree'
} as const
