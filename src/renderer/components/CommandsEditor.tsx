import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { isCommandGroup, type RepoCommand, type RepoCommandEntry } from '@shared/ipc-types'
import { placeholders } from '@shared/repo-commands'
import { clean, duplicateLabels, move, problems } from './commands-editor-model'
import './commands-editor.css'

// Same stroked-icon approach as the changes panel, so the two surfaces match.
const Icon = ({ d, size = 13 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor"
       strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)
const ICONS = {
  up: 'M8 12.5V4M8 4 4.5 7.5M8 4l3.5 3.5',
  down: 'M8 3.5V12M8 12l3.5-3.5M8 12l-3.5-3.5',
  trash: 'M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8',
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 4v8M4 8h8'
} as const

// Editing works on a draft, so Cancel is a real escape and one bad keystroke
// isn't written to disk. Only the active repo's draft is saved at a time.
type Drafts = Record<string, RepoCommandEntry[]>

const NEW_COMMAND: RepoCommand = { label: '', run: '' }

export function CommandsEditor({ onClose }: { onClose: () => void }) {
  const repos = useStore(s => s.repos)

  const [saved, setSaved] = useState<Drafts>({})
  const [drafts, setDrafts] = useState<Drafts>({})
  const [repo, setRepo] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  // Cmd+Up/Down would otherwise switch worktrees while you're typing in here.
  useEffect(() => {
    useStore.getState().pushModal()
    return () => useStore.getState().popModal()
  }, [])

  // Loads once, on open. It must not depend on anything from the store: the
  // worktree list is replaced by a fresh array on every status poll, and
  // re-running this would overwrite whatever you had typed a few seconds ago
  // with what is still on disk. The selection is read at mount instead.
  useEffect(() => {
    let cancelled = false
    window.api.readAllRepoCommands().then(all => {
      if (cancelled) return
      setSaved(all)
      setDrafts(all)
      // Open on the repo you're already working in, not the first one
      // configured — the editor is nearly always reached from its panel.
      const { selected, worktrees } = useStore.getState()
      const own = worktrees.find(w => w.path === selected)
      setRepo(Object.keys(all).find(r => r === own?.path)
        ?? Object.keys(all).find(r => selected?.startsWith(r))
        ?? Object.keys(all)[0])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const entries = (repo && drafts[repo]) || []
  const dirty = (r: string) => JSON.stringify(drafts[r] ?? []) !== JSON.stringify(saved[r] ?? [])
  const dirtyRepos = Object.keys(drafts).filter(dirty)
  const issues = problems(entries)
  const dupes = duplicateLabels(entries)
  // Only what the parser would silently drop blocks the save. Anything merely
  // questionable is said out loud and left to you.
  const blocked = issues.length > 0

  const update = (next: RepoCommandEntry[]) => {
    if (!repo) return
    setJustSaved(false)
    setDrafts(d => ({ ...d, [repo]: next }))
  }

  // Edits address an entry by index, and a group's command by both — flat
  // enough that no id bookkeeping is needed for one level of nesting.
  const patchEntry = (i: number, patch: Partial<RepoCommand & { commands: RepoCommand[] }>) =>
    update(entries.map((e, n) => (n === i ? { ...e, ...patch } as RepoCommandEntry : e)))

  const patchNested = (i: number, j: number, patch: Partial<RepoCommand>) => {
    const group = entries[i]
    if (!isCommandGroup(group)) return
    patchEntry(i, { commands: group.commands.map((c, n) => (n === j ? { ...c, ...patch } : c)) })
  }

  const save = async () => {
    if (!repo || blocked) return
    setSaving(true)
    try {
      // Trimmed on the way out: a trailing space in a label is invisible here
      // but makes the button and its "done" message disagree.
      const stored = await window.api.saveRepoCommands(repo, clean(entries))
      setSaved(s => ({ ...s, [repo]: stored }))
      setDrafts(d => ({ ...d, [repo]: stored }))
      setJustSaved(true)
    } finally { setSaving(false) }
  }

  const nameOf = (path: string) => path.split('/').filter(Boolean).pop() || path

  return (
    <div className="ce-overlay" onClick={onClose}>
      <div className="ce-modal" onClick={e => e.stopPropagation()}
           onKeyDown={e => {
             if (e.key === 'Escape') onClose()
             // Cmd+S saves, the way the raw file would.
             if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save() }
           }}>
        <div className="ce-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ce-title">Repo commands</div>
            <div className="ce-sub">Buttons in the changes panel, per repo</div>
          </div>
          <button className="ce-btn quiet" onClick={() => window.api.openRepoCommandsFile()}
                  title="Open commands.json in your editor">
            Edit as JSON
          </button>
          <button className="ce-icon-btn" onClick={onClose} title="Close">
            <Icon d={ICONS.close} size={11} />
          </button>
        </div>

        {repos.length > 1 && (
          <div className="ce-repo-bar">
            {repos.map(r => (
              <button key={r} className={`ce-tab${r === repo ? ' active' : ''}`}
                      onClick={() => setRepo(r)} title={r}>
                {nameOf(r)}
                {dirty(r) && <span className="ce-dot" title="Unsaved changes" />}
              </button>
            ))}
          </div>
        )}

        <div className="ce-body">
          {loading && <div className="ce-empty">Loading…</div>}
          {!loading && !repo && (
            <div className="ce-empty">Connect a repo first — commands are configured per repo.</div>
          )}
          {!loading && repo && entries.length === 0 && (
            <div className="ce-empty">
              No commands for <strong>{nameOf(repo)}</strong> yet.<br />
              Add one and it appears as a button under the commit box.
            </div>
          )}

          {repo && entries.map((entry, i) => (
            isCommandGroup(entry) ? (
              <div key={i} className="ce-card group">
                <div className="ce-card-head">
                  <span className="ce-card-kind">Group</span>
                  <input className={`ce-input title${entry.label.trim() ? '' : ' invalid'}`}
                         value={entry.label} placeholder="Group name"
                         onChange={e => patchEntry(i, { label: e.target.value })} />
                  <label className="ce-check" title="Whether the group starts expanded">
                    <input type="checkbox" checked={entry.open ?? false}
                           onChange={e => patchEntry(i, { open: e.target.checked } as never)} />
                    Open
                  </label>
                  <button className="ce-icon-btn" title="Move up" disabled={i === 0}
                          onClick={() => update(move(entries, i, -1))}>
                    <Icon d={ICONS.up} size={12} />
                  </button>
                  <button className="ce-icon-btn" title="Move down" disabled={i === entries.length - 1}
                          onClick={() => update(move(entries, i, 1))}>
                    <Icon d={ICONS.down} size={12} />
                  </button>
                  <button className="ce-icon-btn danger" title="Delete group and its commands"
                          onClick={() => update(entries.filter((_, n) => n !== i))}>
                    <Icon d={ICONS.trash} size={12} />
                  </button>
                </div>

                <div className="ce-group-body">
                  {entry.commands.length === 0 && (
                    <div className="ce-group-empty">Empty groups are dropped when saved.</div>
                  )}
                  {entry.commands.map((cmd, j) => (
                    <CommandFields
                      key={j} cmd={cmd} nested
                      first={j === 0} last={j === entry.commands.length - 1}
                      onChange={patch => patchNested(i, j, patch)}
                      onMove={delta => patchEntry(i, { commands: move(entry.commands, j, delta) })}
                      onDelete={() => patchEntry(i, { commands: entry.commands.filter((_, n) => n !== j) })}
                    />
                  ))}
                  <div className="ce-add-row">
                    <button className="ce-btn quiet"
                            onClick={() => patchEntry(i, { commands: [...entry.commands, { ...NEW_COMMAND }] })}>
                      <Icon d={ICONS.plus} size={11} /> Command
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div key={i} className="ce-card">
                <CommandFields
                  cmd={entry}
                  first={i === 0} last={i === entries.length - 1}
                  onChange={patch => patchEntry(i, patch)}
                  onMove={delta => update(move(entries, i, delta))}
                  onDelete={() => update(entries.filter((_, n) => n !== i))}
                />
              </div>
            )
          ))}

          {repo && (
            <div className="ce-add-row">
              <button className="ce-btn" onClick={() => update([...entries, { ...NEW_COMMAND }])}>
                <Icon d={ICONS.plus} size={11} /> Command
              </button>
              <button className="ce-btn"
                      onClick={() => update([...entries, { label: '', commands: [{ ...NEW_COMMAND }] }])}>
                <Icon d={ICONS.plus} size={11} /> Group
              </button>
            </div>
          )}
        </div>

        <div className="ce-foot">
          <span className={`ce-status${blocked || dupes.length ? ' warn' : justSaved ? ' ok' : ''}`}>
            {blocked ? [...new Set(issues)][0]
              : dupes.length ? `More than one button is called "${dupes[0]}".`
              : justSaved ? 'Saved.'
              : dirtyRepos.length > 1 ? `Unsaved changes in ${dirtyRepos.length} repos — save each.`
              : repo && dirty(repo) ? 'Unsaved changes.'
              : ''}
          </span>
          <button className="ce-btn" onClick={onClose}>Close</button>
          <button className="ce-btn primary" onClick={save}
                  disabled={saving || blocked || !repo || !dirty(repo)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CommandFields({ cmd, nested, first, last, onChange, onMove, onDelete }: {
  cmd: RepoCommand
  nested?: boolean
  first: boolean
  last: boolean
  onChange: (patch: Partial<RepoCommand>) => void
  onMove: (delta: number) => void
  onDelete: () => void
}) {
  const { auto, ask } = placeholders(cmd.run)
  return (
    <>
      <div className="ce-card-head" style={nested ? { paddingLeft: 0, paddingRight: 0 } : undefined}>
        {!nested && <span className="ce-card-kind">Button</span>}
        <input className={`ce-input title${cmd.label.trim() ? '' : ' invalid'}`}
               value={cmd.label} placeholder="Button label"
               onChange={e => onChange({ label: e.target.value })} />
        <button className="ce-icon-btn" title="Move up" disabled={first} onClick={() => onMove(-1)}>
          <Icon d={ICONS.up} size={12} />
        </button>
        <button className="ce-icon-btn" title="Move down" disabled={last} onClick={() => onMove(1)}>
          <Icon d={ICONS.down} size={12} />
        </button>
        <button className="ce-icon-btn danger" title="Delete" onClick={onDelete}>
          <Icon d={ICONS.trash} size={12} />
        </button>
      </div>

      <div className="ce-card-body" style={nested ? { padding: '0 0 10px' } : undefined}>
        <div className="ce-field">
          <span className="ce-label">Run</span>
          <input className={`ce-input mono${cmd.run.trim() ? '' : ' invalid'}`}
                 value={cmd.run} spellCheck={false}
                 placeholder={cmd.shell ? 'pnpm build && pnpm test' : 'bash scripts/gate.sh'}
                 onChange={e => onChange({ run: e.target.value })} />
        </div>

        <div className="ce-row">
          <label className="ce-check" title="Where the command runs">
            In
            <select className="ce-select" value={cmd.cwd ?? 'worktree'}
                    onChange={e => onChange({ cwd: e.target.value as 'worktree' | 'repo' })}>
              <option value="worktree">this worktree</option>
              <option value="repo">the repo root</option>
            </select>
          </label>
          <label className="ce-check" title="How much of the button row it takes">
            Width
            <select className="ce-select" value={cmd.width ?? 'half'}
                    onChange={e => onChange({ width: e.target.value as 'half' | 'full' })}>
              <option value="half">half</option>
              <option value="full">full</option>
            </select>
          </label>
          <label className="ce-check"
                 title="Run through sh -c, so &&, pipes, redirects and & work">
            <input type="checkbox" checked={cmd.shell ?? false}
                   onChange={e => onChange({ shell: e.target.checked })} />
            Shell
          </label>
          {(auto.length > 0 || ask.length > 0) && (
            <span className="ce-chips">
              {auto.map(v => <span key={v} className="ce-chip auto" title="Filled in automatically">{`{{${v}}}`}</span>)}
              {ask.map(v => <span key={v} className="ce-chip ask" title="You are asked for this before it runs">{`{{${v}}}`}</span>)}
            </span>
          )}
        </div>

        {/* Only the non-obvious halves get explained, and only when they apply. */}
        {!cmd.shell && /[|&><]|\$\(/.test(cmd.run) && (
          <div className="ce-hint bad">
            &&, pipes and redirects need Shell turned on — without it they are passed as
            literal arguments.
          </div>
        )}
        {ask.length > 0 && (
          <div className="ce-hint">
            Asks for {ask.map(v => v).join(', ')} each time the button is clicked.
          </div>
        )}
      </div>
    </>
  )
}
