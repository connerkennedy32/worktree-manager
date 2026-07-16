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
}

export type WorktreeStep = 'prev' | 'next' | null

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
  if (!modifier) return null
  if (input.key === 'ArrowUp') return 'prev'
  if (input.key === 'ArrowDown') return 'next'
  return null
}

export function attachShortcuts(win: BrowserWindow, isMac = process.platform === 'darwin') {
  win.webContents.on('before-input-event', (event, input) => {
    const step = shortcutFor(input as KeyInput, isMac)
    if (!step) return
    // Keep the key from reaching the renderer, so the terminal never sees it.
    event.preventDefault()
    win.webContents.send(step === 'prev' ? IPC.menuSelectPrev : IPC.menuSelectNext)
  })
}
