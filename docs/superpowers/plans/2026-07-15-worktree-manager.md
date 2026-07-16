# Worktree Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal Electron desktop app that lists git worktrees, gives each an embedded persistent terminal, and shows/stages/commits diffs in-app.

**Architecture:** Electron two-process split. Main (Node) owns git, ptys, and file-watching; renderer (React) draws the sidebar, diff panel, and xterm.js terminal; a typed IPC bridge connects them via a contextBridge preload. Backend git/pty logic is pure, testable modules; the diff feature hides behind a `DiffService` interface so hunk-staging (Phase 4) slots in without a UI reshape.

**Tech Stack:** Electron, electron-vite, React 18, TypeScript, xterm.js + @xterm/addon-fit, node-pty, simple-git, chokidar, react-diff-view, Vitest.

## Global Constraints

- Personal tool only — NO packaging, code-signing, notarization, or auto-update config.
- New worktrees live in a sibling convention: `<repoParent>/.worktrees/<repoName>/<branch>`.
- Destructive actions (removing a worktree with uncommitted changes) must warn; never silently discard.
- Git failures surface as readable error messages, never silent no-ops.
- No push/pull/branch-management features in the diff panel.
- TDD for all backend git/diff logic against throwaway temp repos. Frequent commits.
- All IPC message shapes are defined once in `src/shared/ipc-types.ts` and imported by both sides.

---

## File Structure

```
tmuxWrapper/
  package.json, tsconfig.json, electron.vite.config.ts, vitest.config.ts
  src/
    shared/ipc-types.ts          # typed IPC channel + payload contracts
    main/
      index.ts                   # app + BrowserWindow bootstrap
      ipc.ts                     # registers ipcMain handlers -> services
      config.ts                  # persisted list of tracked repos
      git/worktrees.ts           # list/create/remove worktrees
      git/status.ts              # per-worktree change counts + file status
      git/diff.ts                # DiffService: getDiff/stage/unstage/commit
      terminal/ptyManager.ts     # persistent node-pty per worktree
      watcher.ts                 # chokidar watchers -> status refresh events
    preload/index.ts             # contextBridge exposing typed api
    renderer/
      index.html, main.tsx, App.tsx
      state/store.ts             # zustand store
      components/Sidebar.tsx, NewWorktreeForm.tsx, DiffPanel.tsx, TerminalView.tsx
  tests/
    git/worktrees.test.ts, git/status.test.ts, git/diff.test.ts
    helpers/tmpRepo.ts
```

---

### Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`

**Interfaces:**
- Produces: a launchable Electron window rendering "Worktree Manager" from React; `npm run dev` opens it; `npm test` runs Vitest.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "worktree-manager",
  "version": "0.1.0",
  "private": true,
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "electron-vite": "^2.3.0",
    "vite": "^5.3.0",
    "typescript": "^5.5.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vitest": "^2.0.0"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zustand": "^4.5.0",
    "simple-git": "^3.25.0",
    "chokidar": "^3.6.0",
    "node-pty": "^1.0.0",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "react-diff-view": "^3.2.0",
    "diff": "^5.2.0",
    "refractor": "^4.8.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`, `.gitignore`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src", "tests"]
}
```

`electron.vite.config.ts`:
```ts
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ['node-pty', 'simple-git', 'chokidar'] } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs' } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  resolve: { alias: { '@shared': resolve('src/shared') } }
})
```

`.gitignore`:
```
node_modules/
out/
dist/
.DS_Store
```

- [ ] **Step 3: Create the minimal Electron + React entry files**

`src/main/index.ts`:
```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'path'

function createWindow() {
  const win = new BrowserWindow({
    width: 1300, height: 850,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

`src/preload/index.ts`:
```ts
import { contextBridge } from 'electron'
contextBridge.exposeInMainWorld('api', {})
```

`src/renderer/index.html`:
```html
<!doctype html>
<html>
  <head><meta charset="UTF-8" /><title>Worktree Manager</title></head>
  <body><div id="root"></div><script type="module" src="./main.tsx"></script></body>
</html>
```

`src/renderer/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client'
import { App } from './App'
createRoot(document.getElementById('root')!).render(<App />)
```

`src/renderer/App.tsx`:
```tsx
export function App() {
  return <h1 style={{ fontFamily: 'system-ui', padding: 20 }}>Worktree Manager</h1>
}
```

- [ ] **Step 4: Install and verify it launches**

Run: `npm install` then `npm run dev`
Expected: a window opens showing "Worktree Manager". Close it.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold electron-vite + react + vitest app"
```

---

### Task 1: IPC contract + preload bridge

**Files:**
- Create: `src/shared/ipc-types.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/env.d.ts`

**Interfaces:**
- Produces: `Worktree`, `FileChange`, `DiffFile`, `CommitRequest` types and an `Api` interface exposed on `window.api`, consumed by all later renderer tasks.

- [ ] **Step 1: Define `src/shared/ipc-types.ts`**

```ts
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

export interface StageRequest { worktreePath: string; patch: string; reverse?: boolean }
export interface CommitRequest { worktreePath: string; message: string }
export interface NewWorktreeRequest { repoPath: string; branch: string; createBranch: boolean }

export interface Api {
  listRepos(): Promise<string[]>
  addRepo(path: string): Promise<string[]>
  listWorktrees(repoPath: string): Promise<Worktree[]>
  createWorktree(req: NewWorktreeRequest): Promise<Worktree[]>
  removeWorktree(worktreePath: string, force: boolean): Promise<Worktree[]>
  getStatus(worktreePath: string): Promise<WorktreeStatus>
  getDiff(worktreePath: string): Promise<DiffFile[]>
  stage(req: StageRequest): Promise<void>
  commit(req: CommitRequest): Promise<void>
  openLazygit(worktreePath: string): void
  // terminal
  termStart(worktreePath: string): void
  termInput(worktreePath: string, data: string): void
  termResize(worktreePath: string, cols: number, rows: number): void
  onTermData(cb: (worktreePath: string, data: string) => void): () => void
  onStatusChanged(cb: (worktreePath: string) => void): () => void
}

export const IPC = {
  listRepos: 'repos:list', addRepo: 'repos:add',
  listWorktrees: 'wt:list', createWorktree: 'wt:create', removeWorktree: 'wt:remove',
  getStatus: 'wt:status', getDiff: 'diff:get', stage: 'diff:stage', commit: 'diff:commit',
  openLazygit: 'term:lazygit',
  termStart: 'term:start', termInput: 'term:input', termResize: 'term:resize',
  termData: 'term:data', statusChanged: 'wt:statusChanged'
} as const
```

- [ ] **Step 2: Implement the preload bridge in `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type Api } from '@shared/ipc-types'

const api: Api = {
  listRepos: () => ipcRenderer.invoke(IPC.listRepos),
  addRepo: (p) => ipcRenderer.invoke(IPC.addRepo, p),
  listWorktrees: (r) => ipcRenderer.invoke(IPC.listWorktrees, r),
  createWorktree: (req) => ipcRenderer.invoke(IPC.createWorktree, req),
  removeWorktree: (p, f) => ipcRenderer.invoke(IPC.removeWorktree, p, f),
  getStatus: (p) => ipcRenderer.invoke(IPC.getStatus, p),
  getDiff: (p) => ipcRenderer.invoke(IPC.getDiff, p),
  stage: (req) => ipcRenderer.invoke(IPC.stage, req),
  commit: (req) => ipcRenderer.invoke(IPC.commit, req),
  openLazygit: (p) => ipcRenderer.send(IPC.openLazygit, p),
  termStart: (p) => ipcRenderer.send(IPC.termStart, p),
  termInput: (p, d) => ipcRenderer.send(IPC.termInput, p, d),
  termResize: (p, c, r) => ipcRenderer.send(IPC.termResize, p, c, r),
  onTermData: (cb) => {
    const h = (_e: unknown, p: string, d: string) => cb(p, d)
    ipcRenderer.on(IPC.termData, h as any)
    return () => ipcRenderer.removeListener(IPC.termData, h as any)
  },
  onStatusChanged: (cb) => {
    const h = (_e: unknown, p: string) => cb(p)
    ipcRenderer.on(IPC.statusChanged, h as any)
    return () => ipcRenderer.removeListener(IPC.statusChanged, h as any)
  }
}
contextBridge.exposeInMainWorld('api', api)
```

- [ ] **Step 3: Declare the global in `src/renderer/env.d.ts`**

```ts
import type { Api } from '@shared/ipc-types'
declare global { interface Window { api: Api } }
export {}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: typed IPC contract and preload bridge"
```

---

### Task 2: Temp-repo test helper

**Files:**
- Create: `tests/helpers/tmpRepo.ts`

**Interfaces:**
- Produces: `makeTmpRepo(): Promise<{ dir: string; git: SimpleGit; cleanup: () => void }>` used by all git tests.

- [ ] **Step 1: Write the helper**

```ts
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit, { type SimpleGit } from 'simple-git'
import { writeFileSync } from 'fs'

export async function makeTmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-'))
  const git = simpleGit(dir)
  await git.init(['--initial-branch=main'])
  await git.addConfig('user.email', 'test@test.dev')
  await git.addConfig('user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), '# temp\n')
  await git.add('.')
  await git.commit('initial')
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "test: temp git repo helper"
```

---

### Task 3: Worktree list/create/remove (TDD)

**Files:**
- Create: `src/main/git/worktrees.ts`
- Test: `tests/git/worktrees.test.ts`

**Interfaces:**
- Consumes: `makeTmpRepo` from Task 2; `Worktree`, `NewWorktreeRequest` from Task 1.
- Produces:
  - `listWorktrees(repoPath: string): Promise<Worktree[]>`
  - `createWorktree(req: NewWorktreeRequest): Promise<Worktree[]>`
  - `removeWorktree(worktreePath: string, force: boolean): Promise<Worktree[]>`
  - `worktreeDir(repoPath, branch): string` (sibling convention)

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
import { listWorktrees, createWorktree, removeWorktree } from '../../src/main/git/worktrees'
import { existsSync } from 'fs'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

describe('worktrees', () => {
  it('lists the main worktree', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    const wts = await listWorktrees(r.dir)
    expect(wts).toHaveLength(1)
    expect(wts[0].isMain).toBe(true)
    expect(wts[0].branch).toBe('main')
  })

  it('creates a worktree with a new branch in sibling dir', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    const wts = await createWorktree({ repoPath: r.dir, branch: 'feat-x', createBranch: true })
    expect(wts).toHaveLength(2)
    const created = wts.find(w => w.branch === 'feat-x')!
    expect(created).toBeDefined()
    expect(existsSync(created.path)).toBe(true)
    expect(created.path).toContain('.worktrees')
  })

  it('removes a worktree', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    await createWorktree({ repoPath: r.dir, branch: 'feat-x', createBranch: true })
    let wts = await listWorktrees(r.dir)
    const target = wts.find(w => w.branch === 'feat-x')!
    wts = await removeWorktree(target.path, false)
    expect(wts.find(w => w.branch === 'feat-x')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- worktrees`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/main/git/worktrees.ts`**

```ts
import simpleGit from 'simple-git'
import { basename, dirname, join } from 'path'
import type { Worktree, NewWorktreeRequest } from '@shared/ipc-types'

export function worktreeDir(repoPath: string, branch: string): string {
  const repoName = basename(repoPath)
  const safe = branch.replace(/[/\\]/g, '-')
  return join(dirname(repoPath), '.worktrees', repoName, safe)
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const git = simpleGit(repoPath)
  const raw = await git.raw(['worktree', 'list', '--porcelain'])
  const repoName = basename(repoPath)
  const out: Worktree[] = []
  let cur: Partial<Worktree> = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9).trim(), repoName }
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '').trim()
    else if (line === 'detached') cur.branch = '(detached)'
    else if (line.trim() === '') {
      if (cur.path) { cur.isMain = out.length === 0; out.push(cur as Worktree) }
      cur = {}
    }
  }
  if (cur.path) { cur.isMain = out.length === 0; out.push(cur as Worktree) }
  return out
}

export async function createWorktree(req: NewWorktreeRequest): Promise<Worktree[]> {
  const git = simpleGit(req.repoPath)
  const dir = worktreeDir(req.repoPath, req.branch)
  const args = ['worktree', 'add']
  if (req.createBranch) args.push('-b', req.branch, dir)
  else args.push(dir, req.branch)
  await git.raw(args)
  return listWorktrees(req.repoPath)
}

export async function removeWorktree(worktreePath: string, force: boolean): Promise<Worktree[]> {
  const git = simpleGit(worktreePath)
  const top = (await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  const repoPath = dirname(top) // .git dir's parent is the main worktree
  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')
  await git.raw(args)
  return listWorktrees(repoPath)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- worktrees`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: worktree list/create/remove with sibling dir convention"
```

---

### Task 4: Status + change counts (TDD)

**Files:**
- Create: `src/main/git/status.ts`
- Test: `tests/git/status.test.ts`

**Interfaces:**
- Consumes: `makeTmpRepo`; `WorktreeStatus`, `FileChange`.
- Produces: `getStatus(worktreePath: string): Promise<WorktreeStatus>`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
import { getStatus } from '../../src/main/git/status'
import { writeFileSync } from 'fs'
import { join } from 'path'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

describe('status', () => {
  it('counts modified and untracked files', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    writeFileSync(join(r.dir, 'README.md'), '# changed\n')
    writeFileSync(join(r.dir, 'new.txt'), 'hi\n')
    const s = await getStatus(r.dir)
    expect(s.changeCount).toBe(2)
    expect(s.files.map(f => f.path).sort()).toEqual(['README.md', 'new.txt'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- status`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/main/git/status.ts`**

```ts
import simpleGit from 'simple-git'
import type { WorktreeStatus, FileChange } from '@shared/ipc-types'

export async function getStatus(worktreePath: string): Promise<WorktreeStatus> {
  const git = simpleGit(worktreePath)
  const raw = await git.raw(['status', '--porcelain=v1', '-uall'])
  const files: FileChange[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const index = line[0]
    const working = line[1]
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ')[1] // renames
    files.push({ path, index, working })
  }
  return { worktreePath, files, changeCount: files.length }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- status`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: worktree status and change counts"
```

---

### Task 5: DiffService — read + commit + hunk staging (TDD)

**Files:**
- Create: `src/main/git/diff.ts`
- Test: `tests/git/diff.test.ts`

**Interfaces:**
- Consumes: `makeTmpRepo`; `DiffFile`, `StageRequest`, `CommitRequest`.
- Produces:
  - `getDiff(worktreePath: string): Promise<DiffFile[]>` (unstaged + staged, per file)
  - `stage(req: StageRequest): Promise<void>` (applies a unified-diff patch to the index via `git apply --cached`)
  - `commit(req: CommitRequest): Promise<void>`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
import { getDiff, stage, commit } from '../../src/main/git/diff'
import { getStatus } from '../../src/main/git/status'
import { writeFileSync } from 'fs'
import { join } from 'path'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

describe('diff', () => {
  it('returns a per-file unified patch for a modified file', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    writeFileSync(join(r.dir, 'README.md'), '# temp\nmore\n')
    const diffs = await getDiff(r.dir)
    const f = diffs.find(d => d.path === 'README.md')!
    expect(f).toBeDefined()
    expect(f.rawPatch).toContain('+more')
    expect(f.staged).toBe(false)
  })

  it('stages a file patch then commits', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    writeFileSync(join(r.dir, 'README.md'), '# temp\nmore\n')
    const diffs = await getDiff(r.dir)
    const f = diffs.find(d => d.path === 'README.md')!
    await stage({ worktreePath: r.dir, patch: f.rawPatch })
    let s = await getStatus(r.dir)
    expect(s.files.find(x => x.path === 'README.md')!.index).not.toBe(' ')
    await commit({ worktreePath: r.dir, message: 'add more' })
    s = await getStatus(r.dir)
    expect(s.changeCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- diff`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/main/git/diff.ts`**

```ts
import simpleGit from 'simple-git'
import type { DiffFile, StageRequest, CommitRequest } from '@shared/ipc-types'

// Split `git diff` output into one unified patch per file.
function splitPatches(raw: string): { path: string; oldPath: string; rawPatch: string }[] {
  if (!raw.trim()) return []
  const chunks = raw.split(/(?=^diff --git )/m).filter(c => c.startsWith('diff --git'))
  return chunks.map(rawPatch => {
    const m = rawPatch.match(/^diff --git a\/(.+?) b\/(.+?)$/m)
    const oldPath = m ? m[1] : ''
    const path = m ? m[2] : ''
    return { path, oldPath, rawPatch: rawPatch.endsWith('\n') ? rawPatch : rawPatch + '\n' }
  })
}

export async function getDiff(worktreePath: string): Promise<DiffFile[]> {
  const git = simpleGit(worktreePath)
  // ensure new files show up with content
  const unstaged = await git.raw(['diff'])
  const untracked = (await git.raw(['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)
  let untrackedDiff = ''
  for (const f of untracked) {
    untrackedDiff += await git.raw(['diff', '--no-index', '--', '/dev/null', f]).catch(e => e?.stdout ?? '')
  }
  const staged = await git.raw(['diff', '--cached'])
  const files: DiffFile[] = []
  for (const p of splitPatches(unstaged + untrackedDiff)) files.push({ ...p, hunks: [], staged: false })
  for (const p of splitPatches(staged)) files.push({ ...p, hunks: [], staged: true })
  return files
}

export async function stage(req: StageRequest): Promise<void> {
  const git = simpleGit(req.worktreePath)
  const args = ['apply', '--cached', '--whitespace=nowarn']
  if (req.reverse) args.push('--reverse')
  args.push('-')
  await git.raw(args, req.patch as any).catch(async () => {
    // fall back to piping via stdin using apply with a temp file
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os'); const { join } = await import('path')
    const dir = mkdtempSync(join(tmpdir(), 'wtm-patch-'))
    const pf = join(dir, 'p.diff'); writeFileSync(pf, req.patch)
    const a = ['apply', '--cached', '--whitespace=nowarn']
    if (req.reverse) a.push('--reverse')
    a.push(pf)
    try { await git.raw(a) } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

export async function commit(req: CommitRequest): Promise<void> {
  const git = simpleGit(req.worktreePath)
  await git.commit(req.message)
}
```

> Note: `simple-git`'s `raw` does not stream stdin. The stage implementation therefore always uses the temp-file fallback path; keep it robust by writing the patch to a temp file and running `git apply --cached <file>`. If the initial stdin attempt errors, the fallback runs. This satisfies both file-level and hunk-level staging since a hunk is just a smaller unified patch.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- diff`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: DiffService read/stage/commit via git apply --cached"
```

---

### Task 6: Repo config persistence

**Files:**
- Create: `src/main/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `listRepos(): Promise<string[]>`, `addRepo(path: string): Promise<string[]>`. Persists to a JSON file in `app.getPath('userData')`; tests inject a dir via `WTM_CONFIG_DIR`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

beforeEach(() => { process.env.WTM_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wtm-cfg-')) })

describe('config', () => {
  it('adds and lists repos without duplicates', async () => {
    const { addRepo, listRepos } = await import('../src/main/config')
    await addRepo('/tmp/a')
    await addRepo('/tmp/a')
    await addRepo('/tmp/b')
    expect(await listRepos()).toEqual(['/tmp/a', '/tmp/b'])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -- config` → FAIL.

- [ ] **Step 3: Implement `src/main/config.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

function configDir(): string {
  if (process.env.WTM_CONFIG_DIR) return process.env.WTM_CONFIG_DIR
  // lazy import to avoid loading electron in tests
  const { app } = require('electron')
  return app.getPath('userData')
}
function file(): string { return join(configDir(), 'repos.json') }

export async function listRepos(): Promise<string[]> {
  const f = file()
  if (!existsSync(f)) return []
  try { return JSON.parse(readFileSync(f, 'utf8')).repos ?? [] } catch { return [] }
}
export async function addRepo(path: string): Promise<string[]> {
  const dir = configDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const repos = await listRepos()
  if (!repos.includes(path)) repos.push(path)
  writeFileSync(file(), JSON.stringify({ repos }, null, 2))
  return repos
}
```

- [ ] **Step 4: Run to verify pass** — `npm test -- config` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: persist tracked repos"`

---

### Task 7: PTY manager

**Files:**
- Create: `src/main/terminal/ptyManager.ts`

**Interfaces:**
- Produces: `class PtyManager` with `start(worktreePath, onData)`, `write(worktreePath, data)`, `resize(worktreePath, cols, rows)`, `kill(worktreePath)`, `killAll()`. One persistent pty per worktree path.

- [ ] **Step 1: Implement `src/main/terminal/ptyManager.ts`**

```ts
import * as pty from 'node-pty'
import { platform } from 'os'

type Session = { proc: pty.IPty }

export class PtyManager {
  private sessions = new Map<string, Session>()

  start(worktreePath: string, onData: (data: string) => void) {
    if (this.sessions.has(worktreePath)) return
    const shell = process.env.SHELL || (platform() === 'win32' ? 'powershell.exe' : 'bash')
    const proc = pty.spawn(shell, [], {
      name: 'xterm-color', cols: 100, rows: 30, cwd: worktreePath, env: process.env as any
    })
    proc.onData(onData)
    proc.onExit(() => this.sessions.delete(worktreePath))
    this.sessions.set(worktreePath, { proc })
  }
  write(worktreePath: string, data: string) { this.sessions.get(worktreePath)?.proc.write(data) }
  resize(worktreePath: string, cols: number, rows: number) {
    try { this.sessions.get(worktreePath)?.proc.resize(cols, rows) } catch { /* ignore */ }
  }
  kill(worktreePath: string) { this.sessions.get(worktreePath)?.proc.kill(); this.sessions.delete(worktreePath) }
  killAll() { for (const [, s] of this.sessions) s.proc.kill(); this.sessions.clear() }
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → no errors.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: persistent pty manager (one per worktree)"`

---

### Task 8: File watcher

**Files:**
- Create: `src/main/watcher.ts`

**Interfaces:**
- Produces: `class WatcherManager` with `watch(worktreePath, onChange)` (debounced 300ms, ignores `.git`) and `unwatchAll()`.

- [ ] **Step 1: Implement `src/main/watcher.ts`**

```ts
import chokidar, { type FSWatcher } from 'chokidar'

export class WatcherManager {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()

  watch(worktreePath: string, onChange: () => void) {
    if (this.watchers.has(worktreePath)) return
    const w = chokidar.watch(worktreePath, {
      ignored: /(^|[/\\])\.git([/\\]|$)/, ignoreInitial: true, persistent: true, depth: 10
    })
    const fire = () => {
      clearTimeout(this.timers.get(worktreePath))
      this.timers.set(worktreePath, setTimeout(onChange, 300))
    }
    w.on('all', fire)
    this.watchers.set(worktreePath, w)
  }
  unwatchAll() { for (const [, w] of this.watchers) w.close(); this.watchers.clear() }
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → no errors.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: debounced worktree file watcher"`

---

### Task 9: Wire IPC handlers in main

**Files:**
- Create: `src/main/ipc.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: all Task 3–8 modules; `IPC` channels from Task 1.
- Produces: `registerIpc(win: BrowserWindow)` invoked from `index.ts`.

- [ ] **Step 1: Implement `src/main/ipc.ts`**

```ts
import { ipcMain, BrowserWindow, shell } from 'electron'
import { spawn } from 'child_process'
import { IPC } from '@shared/ipc-types'
import * as wt from './git/worktrees'
import { getStatus } from './git/status'
import * as diff from './git/diff'
import * as config from './config'
import { PtyManager } from './terminal/ptyManager'
import { WatcherManager } from './watcher'

export function registerIpc(win: BrowserWindow) {
  const ptys = new PtyManager()
  const watchers = new WatcherManager()

  ipcMain.handle(IPC.listRepos, () => config.listRepos())
  ipcMain.handle(IPC.addRepo, (_e, p: string) => config.addRepo(p))
  ipcMain.handle(IPC.listWorktrees, (_e, r: string) => wt.listWorktrees(r))
  ipcMain.handle(IPC.createWorktree, (_e, req) => wt.createWorktree(req))
  ipcMain.handle(IPC.removeWorktree, (_e, p: string, f: boolean) => wt.removeWorktree(p, f))
  ipcMain.handle(IPC.getStatus, (_e, p: string) => getStatus(p))
  ipcMain.handle(IPC.getDiff, (_e, p: string) => diff.getDiff(p))
  ipcMain.handle(IPC.stage, (_e, req) => diff.stage(req))
  ipcMain.handle(IPC.commit, (_e, req) => diff.commit(req))

  ipcMain.on(IPC.openLazygit, (_e, p: string) => {
    ptys.start(p, d => win.webContents.send(IPC.termData, p, d))
    ptys.write(p, 'lazygit\n')
  })

  ipcMain.on(IPC.termStart, (_e, p: string) => {
    ptys.start(p, d => win.webContents.send(IPC.termData, p, d))
    watchers.watch(p, () => win.webContents.send(IPC.statusChanged, p))
  })
  ipcMain.on(IPC.termInput, (_e, p: string, data: string) => ptys.write(p, data))
  ipcMain.on(IPC.termResize, (_e, p: string, c: number, r: number) => ptys.resize(p, c, r))

  win.on('closed', () => { ptys.killAll(); watchers.unwatchAll() })
}
```

- [ ] **Step 2: Call it from `src/main/index.ts`** — after creating `win`, add `registerIpc(win)`:

```ts
import { registerIpc } from './ipc'
// inside createWindow, after `const win = new BrowserWindow(...)`:
registerIpc(win)
```

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit` → no errors.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: register all IPC handlers in main"`

---

### Task 10: Renderer store + Sidebar (Phase 1 UI)

**Files:**
- Create: `src/renderer/state/store.ts`, `src/renderer/components/Sidebar.tsx`, `src/renderer/components/NewWorktreeForm.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `window.api` (Task 1).
- Produces: a working sidebar listing worktrees with change badges, create/remove, and selection state `selectedWorktree`.

- [ ] **Step 1: Implement `src/renderer/state/store.ts`**

```ts
import { create } from 'zustand'
import type { Worktree, WorktreeStatus } from '@shared/ipc-types'

interface State {
  repos: string[]
  worktrees: Worktree[]
  statuses: Record<string, WorktreeStatus>
  selected?: string
  init: () => Promise<void>
  refreshWorktrees: () => Promise<void>
  refreshStatus: (p: string) => Promise<void>
  select: (p: string) => void
}

export const useStore = create<State>((set, get) => ({
  repos: [], worktrees: [], statuses: {},
  init: async () => {
    let repos = await window.api.listRepos()
    set({ repos })
    await get().refreshWorktrees()
    window.api.onStatusChanged(p => get().refreshStatus(p))
  },
  refreshWorktrees: async () => {
    const { repos } = get()
    const all: Worktree[] = []
    for (const r of repos) all.push(...await window.api.listWorktrees(r))
    set({ worktrees: all })
    for (const w of all) get().refreshStatus(w.path)
  },
  refreshStatus: async (p) => {
    const s = await window.api.getStatus(p)
    set(st => ({ statuses: { ...st.statuses, [p]: s } }))
  },
  select: (p) => { set({ selected: p }); window.api.termStart(p) }
}))
```

- [ ] **Step 2: Implement `Sidebar.tsx` and `NewWorktreeForm.tsx`**

`src/renderer/components/NewWorktreeForm.tsx`:
```tsx
import { useState } from 'react'
import { useStore } from '../state/store'

export function NewWorktreeForm({ repoPath }: { repoPath: string }) {
  const [branch, setBranch] = useState('')
  const refresh = useStore(s => s.refreshWorktrees)
  return (
    <div style={{ display: 'flex', gap: 4, padding: 8 }}>
      <input placeholder="new branch" value={branch} onChange={e => setBranch(e.target.value)}
             style={{ flex: 1 }} />
      <button onClick={async () => {
        if (!branch) return
        await window.api.createWorktree({ repoPath, branch, createBranch: true })
        setBranch(''); refresh()
      }}>+ Worktree</button>
    </div>
  )
}
```

`src/renderer/components/Sidebar.tsx`:
```tsx
import { useStore } from '../state/store'
import { NewWorktreeForm } from './NewWorktreeForm'

export function Sidebar() {
  const { worktrees, statuses, selected, select, refreshWorktrees, repos } = useStore()
  return (
    <div style={{ width: 260, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column',
                  background: '#1e1e1e', color: '#ddd', fontFamily: 'system-ui', fontSize: 13 }}>
      <div style={{ padding: 8, fontWeight: 600, borderBottom: '1px solid #333' }}>WORKTREES</div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {worktrees.map(w => {
          const count = statuses[w.path]?.changeCount ?? 0
          return (
            <div key={w.path} onClick={() => select(w.path)}
                 style={{ padding: '6px 10px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between',
                          background: selected === w.path ? '#094771' : 'transparent' }}>
              <span>{w.isMain ? '● ' : '▸ '}{w.branch}</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {count > 0 && <span style={{ background: '#c93', color: '#000', borderRadius: 8,
                                             padding: '0 6px', fontSize: 11 }}>{count}</span>}
                {!w.isMain && <span onClick={async (e) => {
                  e.stopPropagation()
                  const c = statuses[w.path]?.changeCount ?? 0
                  if (c > 0 && !confirm(`${w.branch} has ${c} uncommitted changes. Remove anyway?`)) return
                  await window.api.removeWorktree(w.path, c > 0); refreshWorktrees()
                }} style={{ color: '#888' }}>✕</span>}
              </span>
            </div>
          )
        })}
      </div>
      {repos[0] && <NewWorktreeForm repoPath={repos[0]} />}
    </div>
  )
}
```

- [ ] **Step 3: Update `App.tsx` to mount sidebar + init store**

```tsx
import { useEffect } from 'react'
import { useStore } from './state/store'
import { Sidebar } from './components/Sidebar'

export function App() {
  const init = useStore(s => s.init)
  useEffect(() => { init() }, [init])
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#252526' }}>
      <Sidebar />
      <div style={{ flex: 1 }} />
    </div>
  )
}
```

- [ ] **Step 4: Manual verify** — `npm run dev`. With no repos configured the sidebar is empty; open devtools console and run `await window.api.addRepo('<an existing git repo path>')` then reload — worktrees appear with change badges. (A repo picker is added in Task 13.)

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: worktree sidebar with change badges, create/remove"`

---

### Task 11: Embedded terminal (Phase 2 UI)

**Files:**
- Create: `src/renderer/components/TerminalView.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `window.api.termStart/termInput/termResize/onTermData`; xterm.js.
- Produces: a terminal pane bound to the selected worktree; each worktree keeps its own xterm buffer instance so switching preserves scrollback.

- [ ] **Step 1: Implement `src/renderer/components/TerminalView.tsx`**

```tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../state/store'

const terms = new Map<string, { term: Terminal; fit: FitAddon }>()
let dataBound = false

export function TerminalView() {
  const selected = useStore(s => s.selected)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dataBound) {
      window.api.onTermData((p, d) => terms.get(p)?.term.write(d))
      dataBound = true
    }
  }, [])

  useEffect(() => {
    if (!selected || !ref.current) return
    let entry = terms.get(selected)
    if (!entry) {
      const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13,
        theme: { background: '#1e1e1e' }, cursorBlink: true })
      const fit = new FitAddon(); term.loadAddon(fit)
      term.onData(d => window.api.termInput(selected, d))
      entry = { term, fit }; terms.set(selected, entry)
    }
    const el = ref.current
    el.innerHTML = ''
    entry.term.open(el)
    entry.fit.fit()
    window.api.termResize(selected, entry.term.cols, entry.term.rows)
    const onResize = () => { entry!.fit.fit(); window.api.termResize(selected, entry!.term.cols, entry!.term.rows) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [selected])

  return <div ref={ref} style={{ height: '100%', width: '100%', background: '#1e1e1e' }} />
}
```

- [ ] **Step 2: Add terminal + "Open in lazygit" button to `App.tsx`**

```tsx
import { useEffect } from 'react'
import { useStore } from './state/store'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'

export function App() {
  const init = useStore(s => s.init)
  const selected = useStore(s => s.selected)
  useEffect(() => { init() }, [init])
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#252526' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 6, borderBottom: '1px solid #333', display: 'flex', gap: 8,
                      color: '#ddd', fontFamily: 'system-ui', fontSize: 12 }}>
          <span>{selected ?? 'No worktree selected'}</span>
          {selected && <button onClick={() => window.api.openLazygit(selected)}>Open in lazygit</button>}
        </div>
        <div style={{ flex: 1 }}>{selected && <TerminalView />}</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Manual verify** — `npm run dev`, select a worktree: a live shell appears in its directory. Start `sleep 100 &` style long process, switch worktrees and back — buffer persists. "Open in lazygit" launches lazygit in the pane (skip if lazygit not installed).

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: embedded persistent terminal per worktree + lazygit button"`

---

### Task 12: Diff panel (Phases 3 & 4 UI)

**Files:**
- Create: `src/renderer/components/DiffPanel.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `window.api.getDiff/stage/commit`; `react-diff-view` (`parseDiff`, `Diff`, `Hunk`).
- Produces: a diff view with a changed-file list, side-by-side rendering, per-file stage/unstage buttons, and a commit box.

- [ ] **Step 1: Implement `src/renderer/components/DiffPanel.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { parseDiff, Diff, Hunk } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import { useStore } from '../state/store'
import type { DiffFile } from '@shared/ipc-types'

export function DiffPanel() {
  const selected = useStore(s => s.selected)
  const refreshStatus = useStore(s => s.refreshStatus)
  const [files, setFiles] = useState<DiffFile[]>([])
  const [active, setActive] = useState<number>(0)
  const [msg, setMsg] = useState('')

  const load = async () => {
    if (!selected) return
    const f = await window.api.getDiff(selected)
    setFiles(f); setActive(0)
  }
  useEffect(() => { load() }, [selected])

  if (!selected) return null
  const file = files[active]
  const parsed = file ? parseDiff(file.rawPatch, { nearbySequences: 'zip' }) : []

  return (
    <div style={{ display: 'flex', height: '100%', color: '#ddd', fontFamily: 'system-ui', fontSize: 12 }}>
      <div style={{ width: 200, borderRight: '1px solid #333', overflowY: 'auto' }}>
        {files.map((f, i) => (
          <div key={i} onClick={() => setActive(i)}
               style={{ padding: '4px 8px', cursor: 'pointer',
                        background: i === active ? '#094771' : 'transparent' }}>
            <span style={{ color: f.staged ? '#6a9955' : '#c93' }}>{f.staged ? '✓ ' : '• '}</span>
            {f.path}
          </div>
        ))}
        {files.length === 0 && <div style={{ padding: 8, color: '#888' }}>No changes</div>}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'auto', background: '#1e1e1e' }}>
          {file && parsed.map((d: any, i: number) => (
            <div key={i}>
              <div style={{ padding: 4, display: 'flex', gap: 8 }}>
                <button onClick={async () => {
                  await window.api.stage({ worktreePath: selected, patch: file.rawPatch, reverse: file.staged })
                  await load(); refreshStatus(selected)
                }}>{file.staged ? 'Unstage file' : 'Stage file'}</button>
              </div>
              <Diff viewType="split" diffType={d.type} hunks={d.hunks}>
                {(hunks: any[]) => hunks.map((h, hi) => <Hunk key={hi} hunk={h} />)}
              </Diff>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid #333' }}>
          <input placeholder="commit message" value={msg} onChange={e => setMsg(e.target.value)}
                 style={{ flex: 1 }} />
          <button onClick={async () => {
            if (!msg) return
            await window.api.commit({ worktreePath: selected, message: msg })
            setMsg(''); await load(); refreshStatus(selected)
          }}>Commit</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add a tabbed layout (Diff | Terminal) to `App.tsx`**

Replace the right-hand region so the user can toggle between the terminal and the diff panel:

```tsx
import { useEffect, useState } from 'react'
import { useStore } from './state/store'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'
import { DiffPanel } from './components/DiffPanel'

export function App() {
  const init = useStore(s => s.init)
  const selected = useStore(s => s.selected)
  const [tab, setTab] = useState<'terminal' | 'diff'>('terminal')
  useEffect(() => { init() }, [init])
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#252526' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 6, borderBottom: '1px solid #333', display: 'flex', gap: 8,
                      color: '#ddd', fontFamily: 'system-ui', fontSize: 12, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{selected ?? 'No worktree selected'}</span>
          <button onClick={() => setTab('terminal')} disabled={tab === 'terminal'}>Terminal</button>
          <button onClick={() => setTab('diff')} disabled={tab === 'diff'}>Diff</button>
          {selected && <button onClick={() => window.api.openLazygit(selected)}>lazygit</button>}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {selected && <div style={{ height: '100%', display: tab === 'terminal' ? 'block' : 'none' }}><TerminalView /></div>}
          {selected && tab === 'diff' && <DiffPanel />}
        </div>
      </div>
    </div>
  )
}
```

> The terminal stays mounted (via `display:none`) so its buffer and pty binding survive tab switches; the diff panel mounts on demand.

- [ ] **Step 3: Manual verify** — `npm run dev`. Edit a file in a worktree, open Diff tab: file list + side-by-side diff render. "Stage file" moves it to staged (✓), commit box commits and the list clears; the sidebar badge updates.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: diff panel with side-by-side view, file staging, and commit"`

---

### Task 13: Repo picker + finishing touches

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`, `src/main/ipc.ts`, `src/shared/ipc-types.ts`, `src/preload/index.ts`

**Interfaces:**
- Consumes: Electron `dialog`.
- Produces: an "Add repo" button that opens a native folder picker and registers the repo; `Api.pickRepo(): Promise<string[]>`.

- [ ] **Step 1: Add `pickRepo` to the IPC contract** — in `ipc-types.ts` add to `Api`: `pickRepo(): Promise<string[]>` and to `IPC`: `pickRepo: 'repos:pick'`. In `preload/index.ts` add `pickRepo: () => ipcRenderer.invoke(IPC.pickRepo)`.

- [ ] **Step 2: Handle it in `src/main/ipc.ts`** — add inside `registerIpc`:

```ts
import { dialog } from 'electron'
ipcMain.handle(IPC.pickRepo, async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths[0]) return config.listRepos()
  return config.addRepo(r.filePaths[0])
})
```

- [ ] **Step 3: Add the button to `Sidebar.tsx`** — in the header row add:

```tsx
<button onClick={async () => {
  await window.api.pickRepo()
  await useStore.getState().init()
}} style={{ marginLeft: 8, fontSize: 11 }}>+ Repo</button>
```

- [ ] **Step 4: Manual verify** — `npm run dev` with empty config. Click "+ Repo", pick a git repo, its worktrees appear. Full flow works: add repo → create worktree → terminal → edit → diff → stage → commit.

- [ ] **Step 5: Run full test suite** — `npm test` → all green. `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: native repo picker"`

---

## Self-Review Notes

- **Spec coverage:** worktree list/switch (Task 3,10), embedded persistent terminal (Task 7,11), diff viewing goal A (Task 5,12), hunk/line staging goal B (Task 5 `git apply --cached` accepts any sub-patch; Task 12 stages per file, and the same `stage()` accepts a hunk-scoped patch for future line selection), lazygit escape hatch (Task 9,11), sibling worktree convention (Task 3), destructive-remove warning (Task 10), config persistence (Task 6), testing against temp repos (Tasks 2–6). All covered.
- **Hunk-level staging note:** the backend `stage()` already accepts arbitrary unified patches, so line/hunk selection is a renderer-only enhancement (build a patch from selected hunks and pass it to the same `stage()`), deliberately deferred past first working build per YAGNI — the interface does not change.
- **Type consistency:** `Api`/`IPC` are the single source of truth; every renderer call and main handler references them.
