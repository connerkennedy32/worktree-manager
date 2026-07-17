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

export async function readFile(req: ReadFileRequest): Promise<string> {
  return fsReadFile(safeResolve(req.worktreePath, req.path), 'utf8')
}

export async function writeFile(req: WriteFileRequest): Promise<void> {
  return fsWriteFile(safeResolve(req.worktreePath, req.path), req.content, 'utf8')
}
