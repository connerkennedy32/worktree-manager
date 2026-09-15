// Keyboard shortcuts that act on the task list, kept out of the components so
// the decisions are testable without a DOM.
//
// Cmd+C opens the new-task box — but only when there is nothing to copy.
//
// Cmd+C is copy, and this app is mostly a terminal and a diff view, so taking
// the key outright would break the thing it's most used for. With a selection
// it stays copy; with none — where it is a no-op today — it starts a task.
// That keeps the common case untouched and gives the key a second job in the
// moment it had none.

export interface KeyLike {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function isNewTaskKey(e: KeyLike, isMac: boolean, hasSelection: boolean): boolean {
  if (hasSelection) return false
  if (e.altKey || e.shiftKey) return false
  // macOS only. The obvious cross-platform spelling would be Ctrl+C elsewhere,
  // but that is SIGINT: stealing it from a terminal would be far worse than not
  // having the shortcut there at all. Elsewhere the + button is the way in.
  if (!isMac) return false
  if (!e.metaKey || e.ctrlKey) return false
  return e.code ? e.code === 'KeyC' : e.key.toLowerCase() === 'c'
}

// Whether anything on the page is selected, including inside an input or
// textarea — getSelection() reports those as collapsed on some engines, so the
// focused element is checked separately rather than trusted to show up there.
export function hasCopyableSelection(doc: Document): boolean {
  const el = doc.activeElement as HTMLInputElement | HTMLTextAreaElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    if (el.selectionStart !== null && el.selectionStart !== el.selectionEnd) return true
  }
  const sel = doc.getSelection?.()
  return !!sel && !sel.isCollapsed && sel.toString().length > 0
}

/**
 * Which task a Cmd+<number> press means, as a 1-based position, or null.
 *
 * Read from `code` ('Digit3') so it's the physical number row, independent of
 * layout, with the character as the fallback. Zero is not a shortcut: it would
 * have to stand for the tenth task, and "0 means 10" is a rule to remember
 * rather than read.
 */
export function taskDigit(e: KeyLike, isMac: boolean): number | null {
  if (e.altKey || e.shiftKey) return null
  if (isMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return null
  const digit = e.code?.startsWith('Digit') ? e.code.slice(5) : e.key
  if (!/^[1-9]$/.test(digit)) return null
  return Number(digit)
}

