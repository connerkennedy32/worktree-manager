import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync } from 'fs'
import { join, basename, extname } from 'path'

export function configDir(): string {
  if (process.env.WTM_CONFIG_DIR) return process.env.WTM_CONFIG_DIR
  // lazy require so tests never load electron
  const { app } = require('electron')
  return app.getPath('userData')
}
function file(): string { return join(configDir(), 'repos.json') }
function namesFile(): string { return join(configDir(), 'names.json') }

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
