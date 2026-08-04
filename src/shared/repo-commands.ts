import type { RepoCommand } from './ipc-types'

// Not `name`: that is the placeholder the example create-worktree command
// prompts for, and making it implicit would silently stop it asking.
const IMPLICIT_VARS = ['branch', 'worktree', 'worktreeName', 'repo', 'message'] as const

const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g

// Runs before substitution, so a value containing spaces (a commit message)
// stays one argument instead of exploding into several.
export function tokenize(run: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | undefined
  let quoted = false

  for (const ch of run) {
    if (quote) {
      if (ch === quote) quote = undefined
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
    } else if (/\s/.test(ch)) {
      if (cur || quoted) { tokens.push(cur); cur = ''; quoted = false }
    } else cur += ch
  }
  if (cur || quoted) tokens.push(cur)
  return tokens
}

// In first-appearance order, so the prompt's fields read in the same order as
// the command they came from. Deduped: {{name}} twice is one input, used twice.
export function promptVars(run: string): string[] {
  const found: string[] = []
  for (const [, name] of run.matchAll(PLACEHOLDER)) {
    if (IMPLICIT_VARS.includes(name as typeof IMPLICIT_VARS[number])) continue
    if (!found.includes(name)) found.push(name)
  }
  return found
}

// Unknown placeholders resolve to empty rather than being left as literal
// `{{x}}` text, so a mistyped variable can't be passed to git as an argument.
export function substitute(tokens: string[], vars: Record<string, string>): string[] {
  return tokens.map(t => t.replace(PLACEHOLDER, (_m, name: string) => vars[name] ?? ''))
}

// Single quotes with '\'' for embedded ones: inside single quotes sh treats
// everything literally, so a commit message with spaces, $, backticks or a
// stray `;` reaches the command as one argument instead of being run.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Shell mode substitutes into the raw string rather than into tokens, because
// the whole string is the script. Values are quoted for you — writing your own
// quotes around a {{placeholder}} would nest them, not help.
export function substituteShell(run: string, vars: Record<string, string>): string {
  return run.replace(PLACEHOLDER, (_m, name: string) => shellQuote(vars[name] ?? ''))
}

function isRepoCommand(value: unknown): value is RepoCommand {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.label !== 'string' || !v.label.trim()) return false
  if (typeof v.run !== 'string' || !v.run.trim()) return false
  if (v.cwd !== undefined && v.cwd !== 'worktree' && v.cwd !== 'repo') return false
  if (v.shell !== undefined && typeof v.shell !== 'boolean') return false
  return true
}

// Bad entries are dropped individually rather than failing the whole file, so one
// typo doesn't silently remove every button for every repo.
export function parseCommandsFile(raw: unknown): Record<string, RepoCommand[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, RepoCommand[]> = {}
  for (const [repo, value] of Object.entries(raw)) {
    if (repo.startsWith('//')) continue
    if (!Array.isArray(value)) continue
    out[repo] = value.filter(isRepoCommand)
  }
  return out
}

// Keyed by the caller's real tracked repos, never a sample path. A key that
// doesn't match a repo root yields no buttons and no error, so a placeholder
// path here is a silent trap for anyone who edits the commands but not the key.
export function exampleCommandsFile(repoPaths: string[]): string {
  const paths = repoPaths.length ? repoPaths : ['/absolute/path/to/your/repo']
  const example = {
    '// how this works': [
      "Keys are absolute paths to a repo's main checkout — the ones below are yours.",
      'run is tokenized on quotes and spawned directly: no shell, so no && or pipes.',
      'Set "shell": true to run it through sh -c instead, where && | > & all work.',
      '{{branch}} {{worktree}} {{worktreeName}} {{repo}} {{message}} are filled in;',
      '{{worktreeName}} is just the worktree folder name, {{worktree}} its full path.',
      'any other {{placeholder}} is prompted for before the command runs.',
      'In shell mode placeholders are quoted for you - do not quote them yourself.',
      'cwd is "worktree" (default) or "repo".',
      'Delete any repo below you do not want commands for.'
    ],
    ...Object.fromEntries(paths.map(path => [path, [
      // --no-track and the explicit `main` start point are load-bearing: without
      // them git starts the branch at whatever the main checkout is parked on and
      // gives it an upstream, so the new worktree looks like it already has
      // commits to push.
      {
        label: 'Create worktree',
        run: 'git worktree add --no-track -b {{name}} ../.worktrees/{{name}} main',
        cwd: 'repo'
      }
    ]]))
  }
  return `${JSON.stringify(example, null, 2)}\n`
}
