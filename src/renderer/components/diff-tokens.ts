// Syntax highlighting for the diff modal. react-diff-view renders plain text
// unless it is handed a token tree, which `tokenize` builds by running each side
// of the diff through refractor (Prism). Token colours live in diff-theme.css.
import { refractor } from 'refractor/lib/common.js'
import jsx from 'refractor/lang/jsx.js'
import tsx from 'refractor/lang/tsx.js'
import { tokenize, markEdits, type HunkTokens } from 'react-diff-view'

// refractor's "common" bundle omits both, and this is a React + TypeScript repo:
// without them every .tsx file would tokenize as plain TypeScript and mangle its
// JSX. tsx builds on jsx, so the order matters.
refractor.register(jsx)
refractor.register(tsx)

// react-diff-view 3.x treats `refractor.highlight(...)` as a node array, which is
// what refractor 3 returned. refractor 4 returns a hast root object instead, and
// the tokenizer throws trying to iterate it. Unwrap to the children array so the
// two versions agree.
const adapter = {
  highlight: (value: string, language: string) => refractor.highlight(value, language).children
}

// Extension → refractor language. Only names registered above or in the common
// bundle may appear here; an unregistered name makes refractor throw, which
// `languageOf` guards against rather than trusting this table to stay correct.
const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sql: 'sql', swift: 'swift', lua: 'lua',
  pl: 'perl', r: 'r', m: 'objectivec',
  diff: 'diff', patch: 'diff'
}

// Extensionless files worth naming; keyed lowercase.
const BY_NAME: Record<string, string> = { makefile: 'makefile' }

// The language refractor should use for a path, or undefined when we have no
// grammar for it — in which case the caller must skip highlighting entirely,
// since refractor.highlight throws on an unregistered language.
export function languageOf(path: string): string | undefined {
  const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = file.lastIndexOf('.')
  // A leading dot means a dotfile (.gitignore), not an extension.
  const lang = dot > 0 ? BY_EXT[file.slice(dot + 1)] : BY_NAME[file]
  return lang && refractor.registered(lang) ? lang : undefined
}

// Token trees for one file's hunks, or undefined to render as plain text.
// Highlighting is a nicety: any failure here (an unparseable language edge case,
// a pathological line) must degrade to the previous plain-text diff rather than
// take the modal down, so everything is wrapped.
export function tokenizeHunks(hunks: unknown[], language: string | undefined): HunkTokens | undefined {
  if (!language || hunks.length === 0) return undefined
  try {
    return tokenize(hunks as any, {
      highlight: true,
      refractor: adapter as any,
      language,
      // Word-level highlighting inside changed lines, so a one-character edit
      // reads as a one-character edit. 'block' pairs deletions with insertions
      // across the whole hunk, which is what VS Code's diff does.
      enhancers: [markEdits(hunks as any, { type: 'block' })]
    })
  } catch (e) {
    // Warn rather than swallow: silent fallback looks identical to "this language
    // has no grammar", which hid a refractor version mismatch during development.
    console.warn(`[diff] highlighting failed for ${language}, showing plain text`, e)
    return undefined
  }
}
