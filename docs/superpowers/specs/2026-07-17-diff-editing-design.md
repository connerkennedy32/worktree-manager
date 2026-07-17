# Diff Viewer Editing — Design

## Goal

Let the user make minor edits (delete comments, small fixes) to a file directly
from the diff modal, without routing to an external editor. Working-tree files
only.

## Non-goals (YAGNI)

- Syntax highlighting in the editor (plain monospace textarea).
- Editing committed-vs-base diffs (they stay read-only; only working-tree files
  are editable).
- Inline editing of individual diff lines.
- Autosave.

## Main process — new IPC

Two handlers, registered in `src/main/ipc.ts`, exposed through
`src/preload/index.ts` and typed in `src/shared/ipc-types.ts`.

- `readFile({ worktreePath, path }): Promise<string>` — read the on-disk file
  (current working-tree content) as UTF-8.
- `writeFile({ worktreePath, path, content }): Promise<void>` — write `content`
  back to the file as UTF-8.

Path safety: resolve `path` against `worktreePath` and verify the resolved
absolute path stays within `worktreePath` (reject otherwise). This mirrors the
repo-relative path contract already used across the diff IPC.

After a successful write, no explicit refresh call is needed: the existing file
watcher fires `statusChanged`, which the modal already listens to (via `status`)
and refetches the patch. The file list refreshes the same way.

New types in `ipc-types.ts`:

```ts
export interface ReadFileRequest { worktreePath: string; path: string }
export interface WriteFileRequest { worktreePath: string; path: string; content: string }
```

Add to `Api`:

```ts
readFile(req: ReadFileRequest): Promise<string>
writeFile(req: WriteFileRequest): Promise<void>
```

Add to the `IPC` channel map (e.g. `readFile: 'file:read', writeFile: 'file:write'`).

## Renderer — `DiffModal`

New local state:

- `editing: boolean` — whether the editor is shown instead of the diff.
- `draft: string` — the textarea content.
- `original: string` — the loaded file content, to detect unsaved changes
  (`draft !== original`).
- `saving: boolean` — disables Save during the write.

Behavior:

- **Edit button** in the file header, shown only when `activeRow` exists and
  `!activeRow.committed`. Clicking it calls `readFile`, sets `original` and
  `draft`, and enters edit mode.
- In edit mode the diff area (the `overflow: auto` panel) is replaced by a
  full-height monospace `<textarea>` bound to `draft`.
- **Footer** in edit mode: **Cancel** and **Save**.
  - Cancel: if `draft !== original`, confirm ("Discard your edits?"); on confirm
    (or when unchanged), exit edit mode.
  - Save: `writeFile`, then exit edit mode. Disabled while `saving` or when
    `draft === original`.
- **Unsaved-edit guards**: closing the modal (backdrop click, ✕, Escape) and
  switching to another file while `editing && draft !== original` prompt the
  same confirm. Simplest correct approach: block/guard those paths when dirty.
  Escape and switch-file already have handlers to hook into.
- Leaving edit mode does not manually refetch; the watcher-driven `status`
  refresh already updates the diff.

## Testing

- Main: `readFile`/`writeFile` round-trip within a temp worktree; path-escape
  attempt is rejected.
- Renderer (if feasible with existing test setup): entering edit mode loads
  content; Save calls `writeFile` with the draft; dirty Cancel/close prompts
  confirm.
