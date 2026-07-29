import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parseDiff, Diff, Hunk, Decoration } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './diff-theme.css'
import { useStore } from '../state/store'
import { useChangedFiles, codeColor, reconcileTarget, type Row } from './changed-files'
import { languageOf, tokenizeHunks } from './diff-tokens'

type ViewType = 'unified' | 'split'

const VIEW_KEY = 'wtm.diffView'

// Split a repo-relative path for display. No separator means the whole path is the
// filename, which both of these handle via lastIndexOf's -1.
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1)
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

// Preview only makes sense for pages a browser renders as documents.
const isHtml = (p: string) => /\.x?html?$/i.test(p)

const PREVIEW_KEY = 'wtm.diffPreview'

// Cheap content fingerprint (FNV-1a-ish) for the preview's cache-busting nonce.
// Only needs to change when the text changes, so collision quality is irrelevant.
function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

export function DiffModal() {
  const selected = useStore(s => s.selected)
  const openDiff = useStore(s => s.openDiff)
  const setOpenDiff = useStore(s => s.setOpenDiff)
  const refreshStatus = useStore(s => s.refreshStatus)
  const worktrees = useStore(s => s.worktrees)
  const branch = worktrees.find(w => w.path === selected)?.branch

  const { stagedRows, unstagedRows, committedRows, committed, loaded } = useChangedFiles(selected)
  const status = useStore(s => (selected ? s.statuses[selected] : undefined))
  // One entry, scoped to the worktree: row keys like "src/index.ts:w" repeat across
  // worktrees of the same repo, so a bare row key would serve one worktree's diff
  // for another's file. Refetches on every status change, so an open diff tracks
  // edits on disk instead of freezing.
  const [patch, setPatch] = useState<{ key: string; text: string } | null>(null)
  const patchKey = openDiff ? `${selected}\0${openDiff.key}` : ''
  // Side-by-side by default: the modal is wide enough for it. Last choice wins after that.
  const [view, setView] = useState<ViewType>(() =>
    localStorage.getItem(VIEW_KEY) === 'unified' ? 'unified' : 'split')

  const setViewPref = (v: ViewType) => { setView(v); localStorage.setItem(VIEW_KEY, v) }

  // Render-the-page-instead-of-the-diff mode for HTML files, so a markup change can
  // be checked without leaving the app. On by default — opening a page usually means
  // wanting to look at it — and remembered after that, so turning it off sticks. The
  // stored '' (explicitly off) is deliberately distinct from a missing key (default on).
  const [preview, setPreview] = useState(() => (localStorage.getItem(PREVIEW_KEY) ?? '1') === '1')
  const setPreviewPref = (v: boolean) => { setPreview(v); localStorage.setItem(PREVIEW_KEY, v ? '1' : '') }
  const [previewSrc, setPreviewSrc] = useState<string>()
  // Base URL for the open file, and the content hash the frame is currently showing.
  // Refs, not state: they coordinate the two preview effects below without themselves
  // triggering a render (and thus a reload).
  const previewBase = useRef<string>()
  const previewHash = useRef<string>()
  // A fresh iframe paints its own white page before the document renders, which read
  // as a white flash against the dark pane. Hold it transparent until load fires.
  const [previewReady, setPreviewReady] = useState(false)

  // Edit mode: load the working-tree file into a textarea so minor changes
  // (deleting a comment, a one-line fix) can happen here instead of an external
  // editor. `original` is kept to detect unsaved edits; the file watcher refreshes
  // the diff after a save, so no manual refetch is needed.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [original, setOriginal] = useState('')
  const [saving, setSaving] = useState(false)
  const dirty = editing && draft !== original
  // Shared guard for every path that navigates away from an in-progress edit
  // (Escape, backdrop, ✕, rail row switch, Cancel): asks once, consistently.
  const confirmDiscard = () => !dirty || window.confirm('Discard your edits?')

  const allRows = useMemo(
    () => [...stagedRows, ...unstagedRows, ...committedRows],
    [stagedRows, unstagedRows, committedRows])

  useEffect(() => {
    if (!openDiff) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!confirmDiscard()) return
        setOpenDiff(null)
        return
      }
      // j/k step through the file rail. Skip while editing (or when a text field
      // has focus) so the keys type into the textarea instead of navigating.
      if (e.key !== 'j' && e.key !== 'k') return
      if (editing || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const i = allRows.findIndex(r => r.key === openDiff.key)
      if (i === -1) return
      const next = allRows[e.key === 'j' ? i + 1 : i - 1]
      if (!next) return
      e.preventDefault()
      if (!confirmDiscard()) return
      setOpenDiff(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openDiff, setOpenDiff, dirty, editing, allRows])

  // Staging changes a row's key, so follow the file rather than the key; close
  // only when it is genuinely gone. Identity compare: reconcileTarget returns the
  // same object when nothing changed, so this cannot loop.
  useEffect(() => {
    if (!openDiff || !loaded) return
    const next = reconcileTarget(openDiff, allRows)
    // Accepted edge case: this can close/switch (next possibly null) while dirty,
    // bypassing the discard confirm. It's watcher-driven (the file disappeared or
    // moved out from under the modal), so it shouldn't block on a confirm prompt.
    if (next !== openDiff) setOpenDiff(next)
  }, [allRows, openDiff, setOpenDiff, loaded])

  // Switching to a different file (or closing) must abandon any edit session;
  // otherwise the textarea would show one file's draft against another's diff.
  useEffect(() => { setEditing(false) }, [openDiff?.path, selected])

  // Fetch the open file's patch, scoped by worktree + row key. Refetches whenever
  // status changes, so an open diff tracks edits on disk instead of freezing.
  useEffect(() => {
    if (!selected || !openDiff) return
    let cancelled = false
    window.api.getFileDiff({
      worktreePath: selected,
      path: openDiff.path,
      staged: openDiff.staged,
      untracked: openDiff.untracked,
      baseRef: openDiff.committed ? committed?.baseBranch : undefined
    }).then(text => { if (!cancelled) setPatch({ key: patchKey, text }) })
    return () => { cancelled = true }
  }, [selected, openDiff, status, committed?.baseBranch, patchKey])

  const showPreview = preview && !editing && !!openDiff && isHtml(openDiff.path)

  const stageRow = async (row: Row) => {
    if (!selected) return
    await window.api.stagePath({ worktreePath: selected, path: row.path, unstage: row.staged })
    await refreshStatus(selected)
  }

  const stageAll = async () => {
    if (!selected) return
    await window.api.stageAll(selected)
    await refreshStatus(selected)
  }

  // Discarding throws work away irrecoverably, so it must confirm first.
  const discardRow = async (row: Row) => {
    if (!selected) return
    if (!window.confirm(`Discard all changes to ${row.path}? This cannot be undone.`)) return
    await window.api.discardPath({ worktreePath: selected, path: row.path })
    await refreshStatus(selected)
  }

  const startEdit = async () => {
    if (!selected || !openDiff) return
    try {
      const content = await window.api.readFile({ worktreePath: selected, path: openDiff.path })
      setOriginal(content)
      setDraft(content)
      setEditing(true)
    } catch (e) {
      window.alert('Failed to read file: ' + (e as Error).message)
    }
  }

  const cancelEdit = () => {
    if (!confirmDiscard()) return
    setEditing(false)
  }

  const saveEdit = async () => {
    if (!selected || !openDiff) return false
    setSaving(true)
    try {
      await window.api.writeFile({ worktreePath: selected, path: openDiff.path, content: draft })
      setEditing(false)  // watcher-driven status refresh updates the diff
      return true
    } catch (e) {
      window.alert('Failed to save: ' + (e as Error).message)
      // Leave editing true and the draft intact so the edit isn't lost.
      return false
    } finally { setSaving(false) }
  }

  // The browser loads the file from disk, so an unsaved draft would preview
  // stale content. Offer to save first rather than silently showing the old page.
  const openInBrowser = async () => {
    if (!selected || !openDiff) return
    if (dirty) {
      if (!window.confirm('Save your edits before previewing in the browser?')) return
      if (!await saveEdit()) return  // saveEdit already reported the failure
    }
    window.api.openInBrowser(selected, openDiff.path)
  }

  // A refetch of the SAME file keeps showing the old text (no "Loading…" flicker
  // on every status tick); switching files shows "Loading…" immediately.
  const patchText = patch && patch.key === patchKey ? patch.text : undefined
  // Resolve the wtm-preview:// URL as soon as the file opens — deliberately NOT
  // waiting on the patch fetch, which would hold an empty pane for as long as git
  // takes. The protocol handler sends no-store, so the base URL always reads current
  // disk content and needs no nonce on this first load.
  useEffect(() => {
    if (!selected || !openDiff || !showPreview) {
      setPreviewSrc(undefined)
      previewBase.current = undefined
      previewHash.current = undefined
      return
    }
    let cancelled = false
    // Only hidden for a genuinely new page. An in-place reload keeps the old render
    // visible until the new one paints, so an edit doesn't blank the pane.
    setPreviewReady(false)
    window.api.previewUrl(selected, openDiff.path)
      .then(url => {
        if (cancelled) return
        previewBase.current = url
        setPreviewSrc(url)
      })
      .catch(() => { if (!cancelled) setPreviewSrc(undefined) })
    return () => { cancelled = true }
  }, [selected, openDiff?.path, showPreview])

  // Reload the frame when this file's content actually moves. Keyed on a hash of the
  // patch, NOT a timestamp: the watcher ticks status every few seconds even when
  // nothing changed, and a fresh nonce per tick reloaded the page on every tick.
  // The first hash seen for a file is only recorded — the initial load already read
  // that content, so reloading for it would be a redundant flash. Only the src
  // changes here, never the element, so a reload navigates in place with no unmount.
  useEffect(() => {
    if (patchText === undefined || !previewBase.current) return
    const h = hash(patchText)
    if (previewHash.current === h) return
    const first = previewHash.current === undefined
    previewHash.current = h
    if (!first) setPreviewSrc(`${previewBase.current}?wtm=${h}`)
  }, [patchText, previewSrc])

  const parsed = useMemo<any[]>(() => {
    if (!patchText) return []
    try { return parseDiff(patchText, { nearbySequences: 'zip' }) } catch { return [] }
  }, [patchText])

  // getFileDiff fetches exactly one file, so the open row's path names the
  // language for every entry in `parsed`.
  const language = openDiff ? languageOf(openDiff.path) : undefined
  // Tokenizing walks every line of both sides, so it must not rerun on unrelated
  // renders — hovering a rail row, or a status tick that refetches identical
  // text. `parsed` is memoized on the patch text, which makes it a stable key.
  const tokens = useMemo(
    () => parsed.map(d => tokenizeHunks(d.hunks, language)),
    [parsed, language])

  if (!openDiff) return null

  const renderRailRow = (row: Row) => {
    const active = row.key === openDiff.key
    return (
      <div key={row.key} onClick={() => { if (confirmDiscard()) setOpenDiff(row) }}
           // Hover only matters for rows you can move to; the active row already
           // owns its background.
           onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#2a2d2e' }}
           onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
           style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12,
                    // The accent bar carries the selection; it reads at a glance even
                    // against the hover tint, which a background alone did not.
                    borderLeft: `3px solid ${active ? '#4daafc' : 'transparent'}`,
                    padding: '5px 10px 5px 7px',
                    background: active ? '#094771' : 'transparent',
                    color: active ? '#fff' : '#d4d4d4',
                    fontWeight: active ? 600 : 400 }}>
        <span style={{ color: codeColor(row.code), width: 12, textAlign: 'center' }}>{row.code}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                       direction: 'rtl', textAlign: 'left' }} title={row.path}>{row.path}</span>
        {(row.add || row.del) && (
          <span style={{ flexShrink: 0, display: 'flex', gap: 5, fontFamily: 'Menlo, monospace',
                         fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {row.add ? <span style={{ color: active ? '#a6e3a1' : '#6a9955' }}>+{row.add}</span> : null}
            {row.del ? <span style={{ color: active ? '#f28b82' : '#c94a4a' }}>−{row.del}</span> : null}
          </span>
        )}
        <button onClick={e => { e.stopPropagation(); if (selected) window.api.openInEditor(selected, row.path) }}
                title="Open this file in VS Code"
                style={{ background: 'none', border: 'none', color: active ? '#cfe6ff' : '#999',
                         cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '0 2px', width: 18 }}
                onMouseEnter={e => (e.currentTarget.style.color = '#4daafc')}
                onMouseLeave={e => (e.currentTarget.style.color = active ? '#cfe6ff' : '#999')}>
          ↗
        </button>
        {/* Staging and discarding an already-committed file are both meaningless. */}
        {!row.committed && (
          <>
            <button onClick={e => { e.stopPropagation(); discardRow(row) }}
                    title="Discard changes"
                    style={{ background: 'none', border: 'none', color: active ? '#cfe6ff' : '#999',
                             cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px', width: 18 }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#f28b82')}
                    onMouseLeave={e => (e.currentTarget.style.color = active ? '#cfe6ff' : '#999')}>
              ↩
            </button>
            <button onClick={e => { e.stopPropagation(); stageRow(row) }}
                    title={row.staged ? 'Unstage' : 'Stage'}
                    style={{ background: 'none', border: 'none', color: active ? '#cfe6ff' : '#999',
                             cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px', width: 18 }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                    onMouseLeave={e => (e.currentTarget.style.color = active ? '#cfe6ff' : '#999')}>
              {row.staged ? '−' : '+'}
            </button>
          </>
        )}
      </div>
    )
  }

  const renderRailSection = (label: string, rows: Row[], action?: ReactNode) => {
    if (rows.length === 0) return null
    return (
      <div>
        <div style={{ padding: '5px 10px', position: 'sticky', top: 0, zIndex: 1,
                      borderTop: '1px solid #333', borderBottom: '1px solid #2a2a2a',
                      background: '#2d2d2d', fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
                      textTransform: 'uppercase', color: '#bbb', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          {action}
          <span style={{ color: '#888', fontWeight: 400 }}>{rows.length}</span>
        </div>
        {rows.map(renderRailRow)}
      </div>
    )
  }

  const viewBtn = (v: ViewType, label: string) => (
    <button onClick={() => setViewPref(v)}
            style={{ background: view === v ? '#0e639c' : 'transparent', color: view === v ? '#fff' : '#bbb',
                     border: 'none', borderRadius: 3, padding: '3px 10px', cursor: 'pointer', fontSize: 12 }}>
      {label}
    </button>
  )

  const activeRow = allRows.find(r => r.key === openDiff.key)

  return (
    <div onClick={() => { if (confirmDiscard()) setOpenDiff(null) }}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()}
           style={{ background: '#2d2d2d', color: '#d4d4d4', fontFamily: 'system-ui',
                    border: '1px solid #444', borderRadius: 6, boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                    width: 'calc(100vw - 60px)', height: 'calc(100vh - 60px)',
                    display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex',
                      alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>Changes {branch ? `· ${branch}` : ''}</span>
          <span style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 2, background: '#252526', borderRadius: 4, padding: 2 }}>
            {viewBtn('unified', 'Inline')}
            {viewBtn('split', 'Side by side')}
          </div>
          <button onClick={() => { if (confirmDiscard()) setOpenDiff(null) }} title="Close (Esc)"
                  style={{ background: 'none', border: 'none', color: '#ddd', cursor: 'pointer',
                           fontSize: 16, lineHeight: 1, padding: '0 4px' }}>✕</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: 260, borderRight: '1px solid #333', overflowY: 'auto', flexShrink: 0 }}>
            {renderRailSection('Staged', stagedRows)}
            {renderRailSection('Unstaged', unstagedRows,
              <button onClick={e => { e.stopPropagation(); stageAll() }} title="Stage all"
                      style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                               fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                               letterSpacing: 0.5, padding: '0 2px' }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#999')}>
                Stage all
              </button>)}
            {renderRailSection(`Committed vs ${committed?.baseBranch ?? ''}`, committedRows)}
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '7px 12px', borderBottom: '1px solid #333', fontSize: 13,
                          display: 'flex', alignItems: 'center', gap: 8, background: '#252526' }}>
              {/* The filename is what identifies the diff, so it gets the weight; the
                  directory is context and recedes. Ellipsis sits on the directory,
                  which is the half that's expendable when the path is long. */}
              <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline' }}
                    title={openDiff.path}>
                <span style={{ color: '#888', overflow: 'hidden', textOverflow: 'ellipsis',
                               whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>{dirOf(openDiff.path)}</span>
                <span style={{ color: '#fff', fontWeight: 600, flexShrink: 0 }}>{baseOf(openDiff.path)}</span>
                {activeRow && (
                  <span style={{ color: '#888', flexShrink: 0, marginLeft: 8, fontSize: 11 }}>
                    {activeRow.committed ? 'committed' : activeRow.staged ? 'staged' : 'unstaged'}
                  </span>
                )}
              </span>
              {/* Shown while editing too: previewing the page you just changed is
                  the point, and openInBrowser saves the draft first. */}
              {isHtml(openDiff.path) && (
                <>
                  <button onClick={() => setPreviewPref(!preview)}
                          title={preview ? 'Show the diff instead of the rendered page'
                                         : 'Render this page in the pane below'}
                          style={{ background: preview ? '#0e639c' : '#3a3a3a', color: preview ? '#fff' : '#ddd',
                                   border: `1px solid ${preview ? '#0e639c' : '#4a4a4a'}`,
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    Preview
                  </button>
                  <button onClick={openInBrowser} disabled={saving}
                          title="Open this file in your browser"
                          style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    Browser
                  </button>
                </>
              )}
              {!editing && (
                <button onClick={() => selected && window.api.openInEditor(selected, openDiff.path)}
                        title="Open this file in VS Code"
                        style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                 borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                  VS Code
                </button>
              )}
              {activeRow && !activeRow.committed && !editing && (
                <>
                  <button onClick={startEdit}
                          style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    Edit
                  </button>
                  <button onClick={() => discardRow(activeRow)}
                          style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    Discard
                  </button>
                  <button onClick={() => stageRow(activeRow)}
                          style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    {activeRow.staged ? 'Unstage' : 'Stage'}
                  </button>
                </>
              )}
              {editing && (
                <>
                  <button onClick={cancelEdit} disabled={saving}
                          style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                   borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                    Cancel
                  </button>
                  <button onClick={saveEdit} disabled={saving || draft === original}
                          style={{ background: draft === original ? '#3a3a3a' : '#0e639c', color: '#fff',
                                   border: 'none', borderRadius: 4, padding: '2px 10px',
                                   cursor: saving || draft === original ? 'default' : 'pointer', fontSize: 11 }}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: '#1e1e1e' }}>
              {editing ? (
                <textarea value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
                          style={{ width: '100%', height: '100%', boxSizing: 'border-box', resize: 'none',
                                   background: '#1e1e1e', color: '#d4d4d4', border: 'none', outline: 'none',
                                   padding: 12, fontFamily: 'Menlo, monospace', fontSize: 12, lineHeight: 1.5 }} />
              ) : showPreview ? (
                // No `key`: the element must survive a src change so a content reload
                // navigates in place rather than unmounting (which flashed the pane).
                // White backing, since pages that don't set their own background would
                // otherwise render dark text on the modal's dark pane — but only once
                // loaded, so the blank white page never shows.
                previewSrc ? (
                  <iframe src={previewSrc} title="Page preview"
                          onLoad={() => setPreviewReady(true)}
                          // Sandboxed, but with scripts and same-origin so the page
                          // behaves as it would in a browser tab — its own scripts run
                          // and can reach its relative assets. The frame gets no
                          // preload and no node integration.
                          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                          style={{ display: 'block', width: '100%', height: '100%',
                                   border: 'none', background: '#fff',
                                   opacity: previewReady ? 1 : 0,
                                   transition: 'opacity 90ms ease-out' }} />
                ) : null
              ) : (
                <>
                  {patchText === undefined && <div style={{ padding: 12, color: '#888', fontSize: 12 }}>Loading…</div>}
                  {patchText !== undefined && parsed.length === 0 &&
                    <div style={{ padding: 12, color: '#888', fontSize: 12 }}>No textual diff (binary or empty).</div>}
                  {parsed.map((d: any, di: number) => (
                    <Diff key={di} viewType={view} diffType={d.type} hunks={d.hunks} tokens={tokens[di]}>
                      {(hunks: any[]) => hunks.reduce((acc: any[], h, hi) => {
                        const prev = hunks[hi - 1]
                        const skipped = prev ? h.oldStart - (prev.oldStart + prev.oldLines) : 0
                        if (skipped > 0) {
                          acc.push(
                            <Decoration key={`gap-${hi}`}>
                              <div className="diff-gap">
                                <span className="diff-gap-line" />
                                <span className="diff-gap-label">{skipped} unchanged {skipped === 1 ? 'line' : 'lines'} skipped</span>
                                <span className="diff-gap-line" />
                              </div>
                            </Decoration>
                          )
                        }
                        acc.push(<Hunk key={hi} hunk={h} />)
                        return acc
                      }, [])}
                    </Diff>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
