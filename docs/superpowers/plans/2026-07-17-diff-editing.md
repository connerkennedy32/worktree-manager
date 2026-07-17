# Diff Viewer Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user edit working-tree files (delete comments, make minor changes) directly from the diff modal, without an external editor.

**Architecture:** Add two main-process IPC handlers (`readFile`/`writeFile`) backed by a new `src/main/files.ts` module that reads/writes the on-disk file with a path-escape guard. Wire them through preload and the shared `Api` type. In `DiffModal`, add an edit-mode toggle: an Edit button loads the file into a monospace textarea; Save writes it back and the existing file watcher refreshes the diff.

**Tech Stack:** Electron (main/preload/renderer), TypeScript, React, `react-diff-view`, Vitest, `simple-git` (existing), Node `fs`/`path`.

## Global Constraints

- Path safety: every file read/write must resolve the repo-relative `path` against `worktreePath` and reject if the resolved absolute path escapes `worktreePath`.
- Working-tree files only — no editing of committed-vs-base diffs.
- No new runtime dependencies; use Node's built-in `fs`/`path`.
- Follow existing code style: 2-space indent, no semicolons, explanatory comments in the established voice.

---

### Task 1: File read/write module in main process

**Files:**
- Create: `src/main/files.ts`
- Test: `tests/main/files.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `readFile(req: { worktreePath: string; path: string }): Promise<string>`
  - `writeFile(req: { worktreePath: string; path: string; content: string }): Promise<void>`
  - Both throw `Error('path escapes worktree')` when `path` resolves outside `worktreePath`.

- [ ] **Step 1: Write the failing test**

Create `tests/main/files.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFile, writeFile } from '../../src/main/files'

let dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wtm-files-')); dirs.push(d); return d }
afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs = [] })

describe('files', () => {
  it('reads on-disk file content', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    expect(await readFile({ worktreePath: dir, path: 'a.txt' })).toBe('hello\n')
  })

  it('writes content back to the file', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.txt'), 'old\n')
    await writeFile({ worktreePath: dir, path: 'a.txt', content: 'new\n' })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('new\n')
  })

  it('reads a file in a subdirectory', async () => {
    const dir = tmp()
    const sub = join(dir, 'src')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'b.ts'), 'x\n')
    expect(await readFile({ worktreePath: dir, path: 'src/b.ts' })).toBe('x\n')
  })

  it('rejects a path that escapes the worktree', async () => {
    const dir = tmp()
    await expect(readFile({ worktreePath: dir, path: '../secret.txt' }))
      .rejects.toThrow('path escapes worktree')
    await expect(writeFile({ worktreePath: dir, path: '../secret.txt', content: 'x' }))
      .rejects.toThrow('path escapes worktree')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/files.test.ts`
Expected: FAIL — cannot find module `../../src/main/files`.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/files.ts`:

```ts
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises'
import { resolve, relative, isAbsolute } from 'path'

export interface ReadFileRequest { worktreePath: string; path: string }
export interface WriteFileRequest { worktreePath: string; path: string; content: string }

// Resolve a repo-relative path against its worktree and refuse anything that
// escapes it — a stray "../" in a path from the renderer must never reach a file
// outside the worktree the user is looking at.
function safeResolve(worktreePath: string, path: string): string {
  const abs = resolve(worktreePath, path)
  const rel = relative(worktreePath, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path escapes worktree')
  return abs
}

export function readFile(req: ReadFileRequest): Promise<string> {
  return fsReadFile(safeResolve(req.worktreePath, req.path), 'utf8')
}

export function writeFile(req: WriteFileRequest): Promise<void> {
  return fsWriteFile(safeResolve(req.worktreePath, req.path), req.content, 'utf8')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/main/files.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/files.ts tests/main/files.test.ts
git commit -m "feat: add file read/write module with path-escape guard"
```

---

### Task 2: Wire read/write through IPC, preload, and shared types

**Files:**
- Modify: `src/shared/ipc-types.ts` (add request types, `Api` methods, `IPC` channels)
- Modify: `src/main/ipc.ts` (register two handlers)
- Modify: `src/preload/index.ts` (expose two methods)

**Interfaces:**
- Consumes: `readFile`/`writeFile` from `src/main/files.ts` (Task 1).
- Produces (renderer-visible `window.api`):
  - `readFile(req: ReadFileRequest): Promise<string>`
  - `writeFile(req: WriteFileRequest): Promise<void>`

- [ ] **Step 1: Add types and channels to `src/shared/ipc-types.ts`**

After the `DiscardPathRequest` interface (around line 55), add:

```ts
export interface ReadFileRequest { worktreePath: string; path: string }
export interface WriteFileRequest { worktreePath: string; path: string; content: string }
```

In the `Api` interface, after the `getFileDiff` line (around line 70), add:

```ts
  readFile(req: ReadFileRequest): Promise<string>
  writeFile(req: WriteFileRequest): Promise<void>
```

In the `IPC` const, extend the `getFileDiff` line so the diff group reads:

```ts
  getStatus: 'wt:status', getDiff: 'diff:get', getFileDiff: 'diff:file',
  readFile: 'file:read', writeFile: 'file:write',
```

- [ ] **Step 2: Register handlers in `src/main/ipc.ts`**

Add an import near the other main-module imports (after line 8, `import * as diff from './git/diff'`):

```ts
import * as files from './files'
```

After the `IPC.getFileDiff` handler (line 67), add:

```ts
  ipcMain.handle(IPC.readFile, (_e, req) => files.readFile(req))
  ipcMain.handle(IPC.writeFile, (_e, req) => files.writeFile(req))
```

- [ ] **Step 3: Expose methods in `src/preload/index.ts`**

After the `getFileDiff` line (line 15), add:

```ts
  readFile: (req) => ipcRenderer.invoke(IPC.readFile, req),
  writeFile: (req) => ipcRenderer.invoke(IPC.writeFile, req),
```

- [ ] **Step 4: Verify the project typechecks and builds**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (If the repo has no such script target, run `npm run build` and expect success.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat: expose readFile/writeFile over IPC"
```

---

### Task 3: Edit mode in DiffModal

**Files:**
- Modify: `src/renderer/components/DiffModal.tsx`

**Interfaces:**
- Consumes: `window.api.readFile`, `window.api.writeFile` (Task 2); existing `openDiff`, `activeRow`, `selected`, `setOpenDiff`.
- Produces: no exported interface (UI change only).

This task has no unit test (the repo has no React component test harness for the modal; renderer tests cover pure helpers only). It is verified by building and manual exercise in Step 6. Keep the change self-contained.

- [ ] **Step 1: Add edit-mode state**

In `DiffModal`, after the existing `useState` hooks near the top of the component (after the `view` state around line 36), add:

```ts
  // Edit mode: load the working-tree file into a textarea so minor changes
  // (deleting a comment, a one-line fix) can happen here instead of an external
  // editor. `original` is kept to detect unsaved edits; the file watcher refreshes
  // the diff after a save, so no manual refetch is needed.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [original, setOriginal] = useState('')
  const [saving, setSaving] = useState(false)
  const dirty = editing && draft !== original
```

- [ ] **Step 2: Add enter/cancel/save helpers**

After the `discardRow` function (around line 93), add:

```ts
  const startEdit = async () => {
    if (!selected || !openDiff) return
    const content = await window.api.readFile({ worktreePath: selected, path: openDiff.path })
    setOriginal(content)
    setDraft(content)
    setEditing(true)
  }

  const cancelEdit = () => {
    if (draft !== original && !window.confirm('Discard your edits?')) return
    setEditing(false)
  }

  const saveEdit = async () => {
    if (!selected || !openDiff) return
    setSaving(true)
    try {
      await window.api.writeFile({ worktreePath: selected, path: openDiff.path, content: draft })
      setEditing(false)  // watcher-driven status refresh updates the diff
    } finally { setSaving(false) }
  }
```

- [ ] **Step 3: Reset edit mode when the open file changes**

Right after the effect that reconciles the target (the `useEffect` ending around line 58), add an effect so switching files never carries a stale draft:

```ts
  // Switching to a different file (or closing) must abandon any edit session;
  // otherwise the textarea would show one file's draft against another's diff.
  useEffect(() => { setEditing(false) }, [openDiff?.path, selected])
```

- [ ] **Step 4: Guard unsaved edits on Escape and add the Edit button**

Replace the Escape handler effect (lines 44-49) so it warns when dirty:

```ts
  useEffect(() => {
    if (!openDiff) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (dirty && !window.confirm('Discard your edits?')) return
      setOpenDiff(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openDiff, setOpenDiff, dirty])
```

In the file header, replace the `activeRow && !activeRow.committed` action block (lines 241-254) so it also offers Edit, and hides Discard/Stage while editing:

```tsx
              {activeRow && !activeRow.committed && !editing && (
                <>
                  <button onClick={startEdit}
                          style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    Edit
                  </button>
                  <button onClick={() => discardRow(activeRow)}
                          style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    Discard
                  </button>
                  <button onClick={() => stageRow(activeRow)}
                          style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    {activeRow.staged ? 'Unstage' : 'Stage'}
                  </button>
                </>
              )}
              {editing && (
                <>
                  <button onClick={cancelEdit} disabled={saving}
                          style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    Cancel
                  </button>
                  <button onClick={saveEdit} disabled={saving || draft === original}
                          style={{ background: draft === original ? '#3a3a3a' : '#0e639c', color: '#fff',
                                   border: 'none', borderRadius: 4, padding: '2px 10px',
                                   cursor: saving || draft === original ? 'default' : 'pointer', fontSize: 11 }}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
```

- [ ] **Step 5: Render the editor instead of the diff when editing, and guard backdrop close**

Replace the diff body block (the `<div style={{ flex: 1, overflow: 'auto', background: '#1e1e1e' }}>` at lines 256-265) with a conditional that swaps in the textarea:

```tsx
            <div style={{ flex: 1, overflow: 'auto', background: '#1e1e1e' }}>
              {editing ? (
                <textarea value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
                          style={{ width: '100%', height: '100%', boxSizing: 'border-box', resize: 'none',
                                   background: '#1e1e1e', color: '#d4d4d4', border: 'none', outline: 'none',
                                   padding: 12, fontFamily: 'Menlo, monospace', fontSize: 12, lineHeight: 1.5 }} />
              ) : (
                <>
                  {patchText === undefined && <div style={{ padding: 12, color: '#888', fontSize: 12 }}>Loading…</div>}
                  {patchText !== undefined && parsed.length === 0 &&
                    <div style={{ padding: 12, color: '#888', fontSize: 12 }}>No textual diff (binary or empty).</div>}
                  {parsed.map((d: any, di: number) => (
                    <Diff key={di} viewType={view} diffType={d.type} hunks={d.hunks} tokens={tokens[di]}>
                      {(hunks: any[]) => hunks.map((h, hi) => <Hunk key={hi} hunk={h} />)}
                    </Diff>
                  ))}
                </>
              )}
            </div>
```

Update the backdrop click handler (the outer `<div onClick={() => setOpenDiff(null)}` at line 187) to respect unsaved edits:

```tsx
    <div onClick={() => { if (!dirty || window.confirm('Discard your edits?')) setOpenDiff(null) }}
```

And the ✕ close button (line 204) the same way:

```tsx
          <button onClick={() => { if (!dirty || window.confirm('Discard your edits?')) setOpenDiff(null) }} title="Close (Esc)"
```

- [ ] **Step 6: Build and manually verify**

Run: `npm run build`
Expected: build succeeds with no type errors.

Then run the app (`npm run dev` or the project's start command) and confirm:
- Open a working-tree file's diff → an **Edit** button appears; committed files show none.
- Click Edit → the file loads in a textarea; delete a line.
- Save → returns to the diff view and the diff now reflects the deletion.
- Edit again, change something, click Cancel / press Esc / click the backdrop → a "Discard your edits?" confirm appears; declining keeps the editor.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/DiffModal.tsx
git commit -m "feat: edit working-tree files from the diff modal"
```

---

## Self-Review Notes

- **Spec coverage:** readFile/writeFile IPC (Tasks 1–2); path-escape guard (Task 1); Edit button for non-committed rows, textarea swap, Cancel/Save, dirty guards on cancel/close/Escape/backdrop/file-switch (Task 3); watcher-driven refresh (no manual refetch, Task 3 Steps 2–3). Renderer test omitted per spec's "if feasible" — the repo has no modal test harness; covered by manual verification instead.
- **Type consistency:** `ReadFileRequest`/`WriteFileRequest` shapes match across `files.ts`, `ipc-types.ts`, preload, and the modal calls. `readFile` returns `string`, `writeFile` returns `void` everywhere.
