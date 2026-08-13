import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface GhResult { ok: boolean; stdout: string; stderr: string }
export type GhRunner = (args: string[], cwd: string) => Promise<GhResult>

// A packaged Electron app inherits the launchd environment, not a login shell's,
// so PATH usually lacks Homebrew. Try the usual install locations before giving
// up and letting PATH resolution fail with a readable message.
const CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

export function resolveGh(): string {
  return CANDIDATES.find(existsSync) ?? 'gh'
}

// gh writes its payload to stdout and its complaints to stderr, and exits 1 for
// both "no PR here" and real failures — so the caller, not this runner, decides
// what a non-zero exit means.
export const runGh: GhRunner = (args, cwd) =>
  new Promise(resolve => {
    execFile(resolveGh(), args, { cwd, timeout: 15_000, env: process.env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr: stderr || (err?.message ?? '') }))
  })

// gh being absent surfaces as ENOENT from execFile, whose message names the
// binary; the auth prompt is gh's own wording.
export function ghMissing(stderr: string): boolean {
  return /ENOENT/.test(stderr) || /command not found/i.test(stderr) || /spawn .*gh/i.test(stderr)
}

export function ghUnauthenticated(stderr: string): boolean {
  return /gh auth login/i.test(stderr) || /authentication|not logged in/i.test(stderr)
}
