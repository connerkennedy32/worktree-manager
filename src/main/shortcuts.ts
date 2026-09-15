import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-types'

// The subset of Electron's `before-input-event` input we actually decide on.
export interface KeyInput {
  type: string
  key: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  // Physical key ('KeyU'), independent of modifiers. Optional because older
  // callers and tests predate it — see letterPressed for why it's consulted.
  code?: string
}

/**
 * Whether this event is the given letter key, however the platform spelled it.
 *
 * With Ctrl held, `key` is not reliably the letter: depending on the platform
 * and the combination, Chromium reports the letter ('u'), the uppercase form,
 * or the ASCII control character the combination produces (Ctrl+U -> \u0015).
 * `code` is the physical key and is immune to all of that, so it's preferred
 * where present, with the character forms as the fallback.
 */
export function letterPressed(input: KeyInput, letter: string): boolean {
  if (input.code) return input.code === `Key${letter.toUpperCase()}`
  if (input.key.toLowerCase() === letter) return true
  // Ctrl+<letter> collapses to the control character at that letter's position
  // in the alphabet: Ctrl+A is \u0001, Ctrl+U is \u0015.
  return input.key === String.fromCharCode(letter.toLowerCase().charCodeAt(0) - 96)
}

// 'markUnread' is not a step — it acts on the worktree already selected — but
// it rides the same before-input-event path for the same reason the steps do.
export type WorktreeStep =
  'prev' | 'next' | 'prevLane' | 'nextLane' | 'markUnread' | null

// How long a chord prefix stays armed. Long enough to be a deliberate two-key
// sequence, short enough that a stray Ctrl+S doesn't sit there swallowing a 'u'
// typed a minute later in the terminal.
export const CHORD_TIMEOUT_MS = 1500

// Decide whether a key press means "step to another worktree".
//
// This lives in `before-input-event` rather than on the menu items' accelerators.
// A menu accelerator looks like it should work — Electron registers it with the
// native menu — but Chromium offers the key to the renderer first, and xterm
// swallows Cmd+Arrow while the terminal has focus, so the accelerator only fired
// when the sidebar happened to be focused. `before-input-event` runs ahead of the
// renderer and fires regardless of focus.
export function shortcutFor(input: KeyInput, isMac: boolean): WorktreeStep {
  if (input.type !== 'keyDown') return null
  if (input.alt || input.shift) return null
  // Mirror the CmdOrCtrl convention, exclusively: Cmd on macOS, Ctrl elsewhere.
  // Ctrl+Arrow must keep reaching the shell on macOS, where it's a control
  // sequence rather than an app shortcut.
  const modifier = isMac ? input.meta && !input.control : input.control && !input.meta
  if (modifier) {
    if (input.key === 'ArrowUp') return 'prev'
    if (input.key === 'ArrowDown') return 'next'
    if (input.key === 'ArrowLeft') return 'prevLane'
    if (input.key === 'ArrowRight') return 'nextLane'
  }
  // Bare Ctrl+J/Ctrl+K/Ctrl+U (no Cmd/Meta) as a plain-terminal alternative to
  // the arrow/menu shortcuts above. This intentionally shadows readline's Ctrl+K
  // (kill-to-end-of-line), Ctrl+U (kill-line) and fzf's default Ctrl+J/Ctrl+K
  // bindings — accepted tradeoff, not an oversight.
  //
  // Ctrl+U joins them rather than living behind the Ctrl+S chord below because
  // of how it's actually typed: with Caps Lock remapped to "Control when held,
  // Ctrl+S when tapped alone", holding Caps Lock and tapping U *is* Ctrl+U —
  // the Ctrl+S half never fires, since the key was never tapped alone. One held
  // modifier, one letter, same motion as J and K.
  // H and L are the other half of the vi motion J and K already speak: same
  // hand position, same one-held-modifier shape, moving across the board's
  // columns instead of down them. They shadow readline's Ctrl+L (clear) the way
  // J and K shadow their own bindings — the same accepted tradeoff.
  if (input.control && !input.meta) {
    if (letterPressed(input, 'k')) return 'prev'
    if (letterPressed(input, 'j')) return 'next'
    if (letterPressed(input, 'h')) return 'prevLane'
    if (letterPressed(input, 'l')) return 'nextLane'
    if (letterPressed(input, 'u')) return 'markUnread'
  }
  return null
}

// Ctrl+S, the prefix half of the chord. Shared with bindings that live *inside*
// the terminal (Ctrl+S then 'e'), which is why the handler below never
// preventDefaults this key — see attachShortcuts.
// A modifier press on its own — Control, Shift, Alt, Meta, Caps Lock. These are
// not "a key that ends the chord": holding or re-asserting a modifier between
// the two halves is normal, and with Caps Lock remapped to Ctrl (Karabiner's
// "Control when held, Ctrl+S when tapped") the synthetic prefix is *followed* by
// a real Control keyDown, which would otherwise disarm the chord instantly.
export function isModifierKey(input: KeyInput): boolean {
  return ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead'].includes(input.key)
}

export function isChordPrefix(input: KeyInput): boolean {
  return input.type === 'keyDown' && input.control && !input.meta && !input.alt && !input.shift &&
    letterPressed(input, 's')
}

// The second half. Only 'u' (unread) is claimed; every other key falls through
// to whatever the terminal's own chord table does with it.
//
// Ctrl may still be held: the sequence is typed as one motion — hold Ctrl, tap
// S, tap U — the way Ctrl+J/Ctrl+K are, so the second key usually arrives as
// Ctrl+U rather than a bare 'u'. Both spellings complete the chord; releasing
// Ctrl between the two keys is allowed, not required. Cmd and Alt are not, since
// those are someone else's bindings.
function chordAction(input: KeyInput): WorktreeStep {
  if (input.type !== 'keyDown') return null
  if (input.meta || input.alt) return null
  return letterPressed(input, 'u') ? 'markUnread' : null
}

export interface ChordResult {
  action: WorktreeStep
  // Whether to preventDefault, i.e. keep the key from reaching the terminal.
  swallow: boolean
  // When the prefix is armed, or null. Fed back in on the next key.
  prefixAt: number | null
}

/**
 * One key press, given the chord state.
 *
 * The prefix is deliberately *not* swallowed: Ctrl+S is already the prefix for
 * bindings inside the terminal, and eating it here would break every one of
 * them. It is only remembered. If the next key completes a chord we claim, that
 * second key is swallowed and the terminal sees a dangling prefix, which its own
 * chord table times out on — the right trade, since the alternative is breaking
 * the prefix outright.
 */
export function resolveKey(
  input: KeyInput, isMac: boolean, prefixAt: number | null, now: number
): ChordResult {
  const armed = prefixAt !== null && now - prefixAt <= CHORD_TIMEOUT_MS
  if (armed) {
    const action = chordAction(input)
    if (action) return { action, swallow: true, prefixAt: null }
  }
  if (isChordPrefix(input)) return { action: null, swallow: false, prefixAt: now }
  const step = shortcutFor(input, isMac)
  // Any other key down ends the sequence, but still gets its normal handling:
  // with Ctrl held, a tap of S followed by J must still navigate rather than be
  // eaten by a half-finished chord. Key-ups and modifier presses leave the
  // prefix alone — releasing Ctrl+S must not disarm the chord it just armed,
  // and neither must the Control press that follows a remapped Caps Lock.
  const ends = input.type === 'keyDown' && !isModifierKey(input)
  return { action: step, swallow: step !== null, prefixAt: ends || !armed ? null : prefixAt }
}

// Which channel each action rides. A table rather than a chain of ternaries:
// the chain silently routed anything unrecognized to "next".
const CHANNEL: Record<Exclude<WorktreeStep, null>, string> = {
  prev: IPC.menuSelectPrev,
  next: IPC.menuSelectNext,
  prevLane: IPC.menuSelectPrevLane,
  nextLane: IPC.menuSelectNextLane,
  markUnread: IPC.menuMarkUnread
}

export function attachShortcuts(win: BrowserWindow, isMac = process.platform === 'darwin') {
  let prefixAt: number | null = null
  // WTM_DEBUG_KEYS=1 prints every key the window sees and what we decided, for
  // working out why a binding isn't firing. Off by default: this is one line
  // per keystroke, including everything typed into the terminal.
  const debug = process.env.WTM_DEBUG_KEYS === '1'
  win.webContents.on('before-input-event', (event, input) => {
    const r = resolveKey(input as KeyInput, isMac, prefixAt, Date.now())
    if (debug) {
      const i = input as KeyInput
      console.log('[keys]', JSON.stringify({
        type: i.type, key: i.key, code: i.code,
        ctrl: i.control, meta: i.meta, alt: i.alt, shift: i.shift,
        armed: prefixAt !== null, action: r.action, swallow: r.swallow
      }))
    }
    prefixAt = r.prefixAt
    // Keep the key from reaching the renderer, so the terminal never sees it.
    if (r.swallow) event.preventDefault()
    if (!r.action) return
    win.webContents.send(CHANNEL[r.action])
  })
}
