import { describe, it, expect } from 'vitest'
import { parseDiff } from 'react-diff-view'
import { languageOf, tokenizeHunks } from '../../src/renderer/components/diff-tokens'

const patch = `diff --git a/src/app.tsx b/src/app.tsx
index 1111111..2222222 100644
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1,5 +1,5 @@
 // greet the user
 const name = "world"
-export const App = () => <div id="a">{name}</div>
+export const App = () => <div id="b">{name}!</div>
 const n = 42
`

const hunksOf = (text: string) => (parseDiff(text, { nearbySequences: 'zip' }) as any[])[0].hunks

// Every className refractor emitted, and every node type, anywhere in the tree.
const walk = (nodes: any[], classes: Set<string>, types: Set<string>) => {
  for (const n of nodes ?? []) {
    for (const c of n?.properties?.className ?? []) classes.add(c)
    if (n?.type) types.add(n.type)
    if (n?.children) walk(n.children, classes, types)
  }
  return { classes, types }
}

const inspect = (tokens: { old: any[][]; new: any[][] }) =>
  walk([...tokens.old.flat(), ...tokens.new.flat()], new Set(), new Set())

describe('languageOf', () => {
  it('maps extensions to refractor languages', () => {
    expect(languageOf('src/app.tsx')).toBe('tsx')
    expect(languageOf('src/x.ts')).toBe('typescript')
    expect(languageOf('a/b/deep.py')).toBe('python')
  })

  it('names extensionless files it knows, case-insensitively', () => {
    expect(languageOf('Makefile')).toBe('makefile')
  })

  // Each of these would make refractor.highlight throw if it leaked through.
  it('returns undefined rather than an unregistered language', () => {
    expect(languageOf('foo.zzz')).toBeUndefined()
    expect(languageOf('LICENSE')).toBeUndefined()
    // A leading dot is a dotfile, not an extension.
    expect(languageOf('.gitignore')).toBeUndefined()
  })
})

describe('tokenizeHunks', () => {
  it('emits syntax tokens for a tsx patch', () => {
    const tokens = tokenizeHunks(hunksOf(patch), languageOf('src/app.tsx'))
    expect(tokens).toBeDefined()
    const { classes } = inspect(tokens!)
    // JSX only tokenizes as a tag because diff-tokens registers tsx over
    // refractor's common bundle, which omits it.
    for (const c of ['comment', 'keyword', 'string', 'number', 'tag']) {
      expect(classes, `missing token class: ${c}`).toContain(c)
    }
  })

  it('marks word-level edits inside changed lines', () => {
    // markEdits emits type:'edit' nodes; react-diff-view's CodeCell turns those
    // into the .diff-code-edit spans diff-theme.css styles.
    expect(inspect(tokenizeHunks(hunksOf(patch), 'tsx')!).types).toContain('edit')
  })

  it('degrades to plain text instead of throwing', () => {
    expect(tokenizeHunks(hunksOf(patch), undefined)).toBeUndefined()
    expect(tokenizeHunks([], 'tsx')).toBeUndefined()
  })
})
