import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export function configDir(): string {
  if (process.env.WTM_CONFIG_DIR) return process.env.WTM_CONFIG_DIR
  // lazy require so tests never load electron
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

// Stop tracking a repo. Only updates config — never touches files on disk.
export async function removeRepo(path: string): Promise<string[]> {
  const dir = configDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const repos = (await listRepos()).filter(r => r !== path)
  writeFileSync(file(), JSON.stringify({ repos }, null, 2))
  return repos
}
