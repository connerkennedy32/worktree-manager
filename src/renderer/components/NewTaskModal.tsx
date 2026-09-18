import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { branchForTask } from '../state/board'
import { addTask, setBlocked } from '@shared/tasks'
import { commandPromptVars, createWorktreeCommand } from '@shared/repo-commands'

// Making a task is one box and two keys.
//
// Whatever you type is the title, always — there is no second field to fill in
// and no mode to pick. What differs is how you commit it: Enter files the task
// in To do and nothing else happens, ⌘Enter files it *and* starts its worktree
// straight away, using the title as the kickoff the agent is handed. Most of
// the time you already know what the agent should do when you open this box,
// and that case shouldn't cost a round trip through the card.
//
// ⌘Enter closes the box at once and does the work behind it. Creating a
// worktree takes seconds — running the repo's own script, opening tmux, waking
// the agent — and none of it is anything to watch. Since the whole point of the
// key is to get on with something else, holding the modal open would be the one
// thing that stops you.
//
// Nothing is lost by leaving early. The task is filed before any of it starts,
// so a failure has somewhere to land: the card blocks in place with git's own
// words on it, which is where you'd look for it anyway.
//
// ⌘Enter can't always finish the job: a repo whose createWorktree command
// declares placeholders of its own has questions this box can't answer. Then it
// creates the task and opens it, so StartPane asks them — the same place it
// would have asked anyway.
export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const doc = useStore(st => st.tasks)
  const applyTasks = useStore(st => st.applyTasks)
  const repos = useStore(st => st.repos)
  const repo = useStore(st => st.newTaskRepo)
  const setRepo = useStore(st => st.setNewTaskRepo)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState('')

  useEffect(() => { ref.current?.focus() }, [])

  // Cmd+Up/Down would otherwise switch worktrees out from under the box.
  useEffect(() => {
    useStore.getState().pushModal()
    return () => useStore.getState().popModal()
  }, [])

  // Grow to fit: a task worth starting an agent on is often a sentence or two,
  // and a box that scrolls at line two hides what you just wrote.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [value])

  const title = value.trim()

  // Append-only, so the task addTask just made is the last one. addTask doesn't
  // hand back an id and doesn't need to for any other caller.
  const file = (): string | undefined => {
    const next = addTask(doc, title, Date.now(), repo || undefined)
    applyTasks(next)
    return next.tasks[next.tasks.length - 1]?.id
  }

  const save = () => {
    if (!title) return
    file()
    onClose()
  }

  const saveAndStart = () => {
    if (!title) return
    const id = file()
    onClose()
    if (id) void start(id, title, repo || repos[0])
  }

  return (
    <div onClick={onClose}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                  paddingTop: '18vh' }}>
      <div onClick={e => e.stopPropagation()}
           style={{ background: '#2d2d2d', color: '#ddd', fontFamily: 'system-ui',
                    border: '1px solid #444', borderRadius: 8, padding: 18, width: 520,
                    boxShadow: '0 12px 40px rgba(0,0,0,0.55)' }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>New task</div>

        <textarea ref={ref} rows={1} spellCheck={false} value={value}
                  placeholder="What needs doing?"
                  onChange={e => setValue(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation()
                    if (e.key === 'Escape') { onClose(); return }
                    if (e.key !== 'Enter' || e.shiftKey) return
                    e.preventDefault()
                    if (e.metaKey || e.ctrlKey) saveAndStart()
                    else save()
                  }}
                  style={{ width: '100%', boxSizing: 'border-box', background: '#1e1e1e',
                           color: '#eee', border: '1px solid #555', borderRadius: 5,
                           padding: '9px 11px', fontSize: 13, fontFamily: 'system-ui',
                           lineHeight: 1.5, resize: 'none', overflowY: 'auto' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          {repos.length > 0 && (
            <select value={repo}
                    onChange={e => setRepo(e.target.value)}
                    title="Which repo a worktree for this task would be created in"
                    style={{ background: '#1e1e1e', color: '#ccc', border: '1px solid #555',
                             borderRadius: 5, padding: '5px 8px', fontSize: 12 }}>
              {repos.map(r => (
                <option key={r} value={r}>{r.split('/').filter(Boolean).pop()}</option>
              ))}
              <option value="">no repo</option>
            </select>
          )}
          <div style={{ flex: 1 }} />
          <button className="wt-btn wt-btn-ghost" onClick={save} disabled={!title}>
            Save
          </button>
          <button className="wt-btn wt-btn-primary" onClick={saveAndStart} disabled={!title}>
            Save &amp; start
          </button>
        </div>

        <div style={{ fontSize: 11, color: '#777', marginTop: 10 }}>
          <b style={{ color: '#999' }}>⏎</b> save · <b style={{ color: '#999' }}>⌘⏎</b> save
          {' '}and start the worktree · <b style={{ color: '#999' }}>⇧⏎</b> new line
        </div>
      </div>
    </div>
  )
}

// Everything ⌘Enter sets in motion after the modal is gone. Deliberately not a
// method on the component: it outlives it, so it reads the store rather than
// closing over props that unmounted, and it reports by marking the card instead
// of by returning.
async function start(id: string, title: string, repo?: string): Promise<void> {
  const { openTask, startWorktree, startWorktreeWithCommand } = useStore.getState()

  // A failure has no modal left to show it in, so it goes on the card: blocked,
  // in place, carrying git's own words. Read fresh — the document has moved on
  // since the task was filed.
  const blame = (reason: string): void => {
    useStore.getState().applyTasks(setBlocked(useStore.getState().tasks, id, reason))
  }

  // No repo means there is nothing to create a worktree in. Open the task so the
  // reason is on screen rather than swallowed.
  if (!repo) { openTask(id); return }

  try {
    const command = createWorktreeCommand(
      await window.api.listRepoCommands(repo).catch(() => [])
    ) ?? null
    // Placeholders beyond {{branch}} and {{prompt}} are the author's own and
    // have no answer here. Open the task and let StartPane ask.
    if (command && commandPromptVars(command).length > 0) { openTask(id); return }

    const branch = branchForTask(title)
    if (!branch) return blame('That title has nothing to make a branch name out of.')

    // Deliberately not navigating: ⌘Enter is the "fire it off and get on with
    // something else" key. The agent still starts — it just starts offscreen.
    const message = command
      ? await startWorktreeWithCommand(id, command, branch, {}, title, { navigate: false })
      : await startWorktree(id, branch, { navigate: false })
    if (message) blame(message)
  } catch (e: any) {
    blame(String(e?.message ?? e))
  }
}
