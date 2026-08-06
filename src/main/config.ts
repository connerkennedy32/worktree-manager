import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync } from 'fs'
import { join, basename, extname } from 'path'
import type { RepoCommandEntry } from '@shared/ipc-types'
import { repoRoot } from './git/repo-root'
import { parseCommandsFile, exampleCommandsFile } from '@shared/repo-commands'

export function configDir(): string {
  if (process.env.WTM_CONFIG_DIR) return process.env.WTM_CONFIG_DIR
  // lazy require so tests never load electron
  const { app } = require('electron')
  return app.getPath('userData')
}
function file(): string { return join(configDir(), 'repos.json') }
function namesFile(): string { return join(configDir(), 'names.json') }
function commandsFile(): string { return join(configDir(), 'commands.json') }

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

// Custom, user-chosen worktree tab names, keyed by worktree path. Persisted in
// userData so they survive a renderer storage clear ("reset local dev").
export async function listNames(): Promise<Record<string, string>> {
  const f = namesFile()
  if (!existsSync(f)) return {}
  try { return JSON.parse(readFileSync(f, 'utf8')).names ?? {} } catch { return {} }
}

// An empty/whitespace name clears the override, restoring the path-derived default.
export async function setName(path: string, name: string): Promise<Record<string, string>> {
  const dir = configDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const names = await listNames()
  const trimmed = name.trim()
  if (trimmed) names[path] = trimmed
  else delete names[path]
  writeFileSync(namesFile(), JSON.stringify({ names }, null, 2))
  return names
}

// --- Backgrounds -----------------------------------------------------------
// User-added background images/videos live as files under userData/backgrounds
// and are served to the renderer via the wtm-bg:// protocol. The current
// selection (a bare filename, or '' for the app's built-in default) is kept in
// background.json so it survives a renderer storage clear, like names above.

const BG_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', // images
  '.mp4', '.webm', '.mov', '.m4v', '.ogv'                     // videos
])

export function backgroundsDir(): string {
  const dir = join(configDir(), 'backgrounds')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
function bgSelectionFile(): string { return join(configDir(), 'background.json') }

export async function listBackgrounds(): Promise<string[]> {
  try {
    return readdirSync(backgroundsDir())
      .filter(f => BG_EXTS.has(extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
  } catch { return [] }
}

// Copy a picked file into the backgrounds dir and return its stored filename.
// De-dupes names by appending a counter, so adding two files with the same
// basename keeps both.
export async function addBackground(srcPath: string): Promise<string> {
  const dir = backgroundsDir()
  const ext = extname(srcPath)
  const stem = basename(srcPath, ext)
  let name = `${stem}${ext}`
  let n = 1
  while (existsSync(join(dir, name))) name = `${stem} (${n++})${ext}`
  copyFileSync(srcPath, join(dir, name))
  return name
}

// Delete a background file. If it was the selected one, fall back to default.
export async function removeBackground(name: string): Promise<string[]> {
  const safe = basename(name) // never let a name escape the backgrounds dir
  const f = join(backgroundsDir(), safe)
  if (existsSync(f)) unlinkSync(f)
  if ((await getSelectedBackground()) === safe) await setSelectedBackground('')
  return listBackgrounds()
}

export async function getSelectedBackground(): Promise<string> {
  const f = bgSelectionFile()
  if (!existsSync(f)) return ''
  try { return JSON.parse(readFileSync(f, 'utf8')).selected ?? '' } catch { return '' }
}

// Empty string selects the app's built-in default backdrop.
export async function setSelectedBackground(name: string): Promise<string> {
  const dir = configDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const selected = name ? basename(name) : ''
  writeFileSync(bgSelectionFile(), JSON.stringify({ selected }, null, 2))
  return selected
}

// Stop tracking a repo. Only updates config — never touches files on disk.
export async function removeRepo(path: string): Promise<string[]> {
  const dir = configDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const repos = (await listRepos()).filter(r => r !== path)
  writeFileSync(file(), JSON.stringify({ repos }, null, 2))
  return repos
}

// Keyed by main-checkout path, so every worktree of a repo gets the same commands.
export async function listRepoCommands(worktreePath: string): Promise<RepoCommandEntry[]> {
  const f = commandsFile()
  if (!existsSync(f)) return []
  try {
    const root = await repoRoot(worktreePath)
    const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
    return parseCommandsFile(parsed)[root] ?? []
  } catch { return [] }
}

// The whole file at once, for the commands editor. Repos with no entries are
// still keyed (as []), so the editor can list every connected repo without
// having to reconcile two sources.
export async function readAllRepoCommands(): Promise<Record<string, RepoCommandEntry[]>> {
  const repos = await listRepos()
  const f = commandsFile()
  let parsed: Record<string, RepoCommandEntry[]> = {}
  if (existsSync(f)) {
    try { parsed = parseCommandsFile(JSON.parse(readFileSync(f, 'utf8'))) } catch { parsed = {} }
  }
  return Object.fromEntries(repos.map(r => [r, parsed[r] ?? []]))
}

// Rewrites one repo's entries and leaves the rest of the file byte-for-byte
// alone in content — other repos, and the `//` help comments, are read back
// from the raw JSON rather than from the parsed form, so saving from the editor
// can never drop a key the parser doesn't model. A repo with no commands has
// its key removed rather than written as [], so the file doesn't accumulate
// empty entries for every repo ever opened in the editor.
export async function saveRepoCommands(
  repoPath: string, entries: RepoCommandEntry[]
): Promise<RepoCommandEntry[]> {
  const dir = configDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const f = commandsFile()
  let raw: Record<string, unknown> = {}
  if (existsSync(f)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(f, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>
      }
    } catch { raw = {} }
  }
  if (entries.length) raw[repoPath] = entries
  else delete raw[repoPath]
  writeFileSync(f, `${JSON.stringify(raw, null, 2)}\n`)
  return parseCommandsFile(raw)[repoPath] ?? []
}

export async function openRepoCommandsFile(): Promise<void> {
  const dir = configDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const f = commandsFile()
  if (!existsSync(f)) writeFileSync(f, exampleCommandsFile(await listRepos()))
  const { shell } = require('electron')
  await shell.openPath(f)
}
