import type { AgentReport } from './agent-status'
import type { PrStatus } from './pr-status'
import type { TasksDoc } from './tasks'

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

// A refresh reports both what it learned and, if the machine's gh is missing or
// logged out, one message explaining why nothing came back — the button needs
// something to say, and that failure is not per worktree.
export interface PrRefreshResult {
  statuses: Record<string, PrStatus>
  error?: string
}

export type CommandOutcome = {
  ok: boolean
  message: string
  // Follow-ups the command asked for, resolved by main: an absolute worktree
  // path to select, and terminal lines with placeholders already substituted.
  // Only present on a successful run.
  select?: string
  terminal?: string[]
}

export interface RepoCommand {
  label: string
  // Marks this as the command a task runs instead of the built-in git for that
  // side of a worktree's life: 'createWorktree' replaces `git worktree add`, so
  // the repo's own flow — tmux, an agent, a kickoff message — is what a task
  // starts with; 'removeWorktree' replaces `git worktree remove`, for repos
  // whose teardown does more than git does (dropping databases, trashing
  // node_modules out of band). One of each per repo; the first found wins.
  role?: 'createWorktree' | 'removeWorktree'
  // Tokenized on quotes and spawned directly, never through a shell: no `&&`,
  // no pipes, no $VAR. {{branch}}, {{worktree}}, {{worktreeName}}, {{repo}} and
  // {{message}} (the commit box) are substituted; any other {{placeholder}} is
  // prompted for.
  run: string
  cwd?: 'worktree' | 'repo'   // default 'worktree'
  // How much of the two-column action row the button takes. 'full' spans both
  // columns, for a label that would otherwise be truncated. Default 'half'.
  width?: 'half' | 'full'
  // With shell: true, `run` is handed to `sh -c` verbatim after substitution
  // instead of being tokenized, so `&&`, pipes, redirects and `&` work. Opt-in
  // because it also means a {{placeholder}} value is interpreted by the shell.
  shell?: boolean
  // After the command succeeds, select this worktree in the sidebar. Resolved
  // against the command's effective cwd, so `../.worktrees/{{name}}` works from
  // a `cwd: "repo"` command. A path that matches no worktree is a no-op.
  select?: string
  // Lines typed into the selected worktree's terminal, each followed by Enter.
  // Without `select`, they go to whatever worktree is already selected.
  terminal?: string[]
}

// A named, collapsible set of buttons. Groups don't nest: one level keeps the
// panel scannable, and a group inside a group would be a folder tree, not a
// button bar.
export interface RepoCommandGroup {
  label: string
  commands: RepoCommand[]
  // Whether the group starts open. Default false — the point of a group is to
  // get its buttons out of the way until they're wanted.
  open?: boolean
}

// The commands array for a repo holds either kind, in the order written, so a
// file with no groups behaves exactly as it did before.
export type RepoCommandEntry = RepoCommand | RepoCommandGroup

export function isCommandGroup(entry: RepoCommandEntry): entry is RepoCommandGroup {
  return Array.isArray((entry as RepoCommandGroup).commands)
}

export interface RunRepoCommandRequest {
  worktreePath: string
  command: RepoCommand
  // Keyed by placeholder name; every {{placeholder}} the command declares needs one.
  inputs?: Record<string, string>
  message?: string
  branch?: string
  // {{prompt}}: what a task's start pane was told to kick the agent off with.
  // Implicit like branch and message, so it is passed rather than prompted for.
  prompt?: string
}

export interface GtCreateRequest {
  worktreePath: string
  branch: string
  message: string
  stageAll: boolean
}

export interface CommittedChanges {
  baseBranch: string    // branch of the repo's main worktree; '' when unresolvable
  files: CommittedFile[]
}

export interface CreateWorktreeRequest { repoPath: string; branch: string }

// Creating can fail for reasons the user can fix (branch already exists, dirty
// index), so it reports an outcome rather than throwing — same contract as
// push, and for the same reason: a thrown main-process error arrives wrapped.
export type CreateWorktreeOutcome =
  | { ok: true; path: string }
  | { ok: false; message: string }

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
  // The global task list. Whole-document read/write, same shape as layout:
  // setTasks replaces it and echoes back what was stored.
  getTasks(): Promise<TasksDoc>
  setTasks(doc: TasksDoc): Promise<TasksDoc>
  // Background backdrop. Files live in userData/backgrounds and are managed from
  // the Background app menu; the renderer only reads the current selection (a
  // bare filename, or '' for the built-in default) and re-reads it when the menu
  // changes it. Files are served via the wtm-bg:// protocol.
  getSelectedBackground(): Promise<string>
  onBackgroundChanged(cb: () => void): () => void
  listWorktrees(repoPath: string): Promise<Worktree[]>
  removeWorktree(worktreePath: string, force: boolean): Promise<Worktree[]>
  // Create a worktree for a new branch, in the app's sibling convention. Used by
  // a task that needs a terminal and doesn't have one yet.
  createWorktree(req: CreateWorktreeRequest): Promise<CreateWorktreeOutcome>
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
  // GitHub PR state per worktree. getPrStatuses returns the disk cache without
  // touching the network; refreshPrStatuses shells out to `gh` once per path and
  // is only ever called from the sidebar's refresh button.
  getPrStatuses(): Promise<Record<string, PrStatus>>
  refreshPrStatuses(worktreePaths: string[]): Promise<PrRefreshResult>
  // Open an absolute https URL in the OS browser. Distinct from openInBrowser,
  // which takes a worktree-relative file and builds a file:// URL from it.
  openUrl(url: string): void
  gtCreate(req: GtCreateRequest): Promise<CommandOutcome>
  listRepoCommands(worktreePath: string): Promise<RepoCommandEntry[]>
  runRepoCommand(req: RunRepoCommandRequest): Promise<CommandOutcome>
  openRepoCommandsFile(): Promise<void>
  // Every connected repo's commands, for the editor. Keyed by repo path, with
  // an empty array for a repo that has none yet.
  readAllRepoCommands(): Promise<Record<string, RepoCommandEntry[]>>
  // Replace one repo's entries. Returns them as re-parsed from disk, so the
  // editor shows what was actually stored rather than what it sent.
  saveRepoCommands(repoPath: string, entries: RepoCommandEntry[]): Promise<RepoCommandEntry[]>
  onMenuEditCommands(cb: () => void): () => void
  // Repos are added and disconnected from the Repos menu now that there is no
  // sidebar. Main does the work and then tells the renderer to re-read.
  onReposChanged(cb: () => void): () => void
  // Fires after the editor writes commands.json, so open panels re-read it.
  onCommandsChanged(cb: () => void): () => void
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
  // Types lines into a worktree's terminal, starting it if needed. Fire-and-
  // forget: pacing between lines happens in main.
  termRunLines(worktreePath: string, lines: string[]): void
  termResize(worktreePath: string, cols: number, rows: number): void
  // Brings the app window to the foreground (e.g. when a file drag enters it),
  // so drops land without first clicking the app to focus it.
  focusWindow(): void
  onTermData(cb: (worktreePath: string, data: string) => void): () => void
  onStatusChanged(cb: (worktreePath: string) => void): () => void
  getAgentStatuses(): Promise<Record<string, AgentReport>>
  onAgentStatus(cb: (worktreePath: string, report: AgentReport) => void): () => void
  onMenuResetTerminal(cb: () => void): () => void
  onMenuSelectPrev(cb: () => void): () => void
  onMenuSelectNext(cb: () => void): () => void
  onMenuSelectPrevLane(cb: () => void): () => void
  onMenuSelectNextLane(cb: () => void): () => void
  // Worktree › Mark Unread (Ctrl+S U): flags the selected worktree so it draws the
  // same green "unhandled" dot a finished agent turn does.
  onMenuMarkUnread(cb: () => void): () => void
  // View › Toggle List Layout: swaps the board for the single-column list down
  // the left edge, which is what makes the app usable on a short screen.
  onMenuToggleLayout(cb: () => void): () => void
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
  getTasks: 'tasks:get', setTasks: 'tasks:set',
  getSelectedBackground: 'bg:get', backgroundChanged: 'bg:changed',
  listWorktrees: 'wt:list', removeWorktree: 'wt:remove', createWorktree: 'wt:create',
  getStatus: 'wt:status', getDiff: 'diff:get', getFileDiff: 'diff:file',
  readFile: 'file:read', writeFile: 'file:write',
  getCommittedFiles: 'diff:committed',
  stage: 'diff:stage', stagePath: 'diff:stagePath', stageAll: 'diff:stageAll',
  discardPath: 'diff:discardPath', commit: 'diff:commit',
  pendingCount: 'push:pending', push: 'push:run', syncWithTrunk: 'sync:trunk',
  gtCreate: 'stack:gtCreate',
  getPrStatuses: 'pr:get', refreshPrStatuses: 'pr:refresh', openUrl: 'browser:openUrl',
  listRepoCommands: 'cmd:list', runRepoCommand: 'cmd:run',
  openRepoCommandsFile: 'cmd:openFile',
  readAllRepoCommands: 'cmd:readAll', saveRepoCommands: 'cmd:save',
  menuEditCommands: 'menu:editCommands', commandsChanged: 'cmd:changed',
  reposChanged: 'repos:changed',
  gitOutput: 'git:output',
  openLazygit: 'term:lazygit',
  openInEditor: 'editor:open',
  openInBrowser: 'browser:open',
  previewUrl: 'preview:url',
  listTerminals: 'term:list',
  termStart: 'term:start', termReset: 'term:reset', termInput: 'term:input', termResize: 'term:resize',
  termRunLines: 'term:runLines',
  termData: 'term:data', statusChanged: 'wt:statusChanged',
  focusWindow: 'win:focus',
  getAgentStatuses: 'agent:list', agentStatus: 'agent:status',
  menuResetTerminal: 'menu:resetTerminal',
  menuSelectPrev: 'menu:selectPrev', menuSelectNext: 'menu:selectNext',
  menuSelectPrevLane: 'menu:selectPrevLane', menuSelectNextLane: 'menu:selectNextLane',
  menuMarkUnread: 'menu:markUnread',
  menuToggleLayout: 'menu:toggleLayout'
} as const
