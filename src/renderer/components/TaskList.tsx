import { useState } from 'react'
import { useStore } from '../state/store'
import {
  Card, NewTask, RepoRail, TASK_MIME, useCardFlip, useTaskKeys
} from './Board'
import {
  dropTask, LANE_LABEL, LANES, laneOf, tasksInLane, type Lane, type Task
} from '@shared/tasks'
import './board-theme.css'

// The other layout: the same cards, stacked in one column down the left edge,
// with the terminal taking the whole height beside it. The board is the better
// view when there is room for it — but on a short screen a horizontal split
// leaves neither half usable, and this trades the lanes' side-by-side reading
// for a terminal that is actually tall enough to work in.
//
// Deliberately the same Card, not a smaller variant: the point is that this is
// the board seen end-on, and a card that looked different here would be a
// second thing to learn.
export function TaskList() {
  useTaskKeys()
  const doc = useStore(st => st.tasks)
  useCardFlip(doc.tasks.map(t => `${t.id}:${laneOf(t)}`).join(','))

  return (
    <div className="wt-list">
      <RepoRail />
      <div className="wt-list-body">
        {LANES.map(lane => (
          <LaneGroup key={lane} lane={lane} tasks={tasksInLane(doc, lane)} />
        ))}
      </div>
    </div>
  )
}

// A lane, as a heading with its cards under it. The heading is what separates
// the lanes when they share one column, so it is also the drop target: dropping
// on the gap under a lane's last card has to mean the same thing it means on
// the board, or dragging stops working in this layout.
function LaneGroup({ lane, tasks }: { lane: Lane; tasks: Task[] }) {
  const applyTasks = useStore(st => st.applyTasks)
  const [over, setOver] = useState(false)

  // An empty lane is a heading over nothing. To do keeps its heading whatever
  // happens — the new-task box lives under it — but the others aren't drawn,
  // since in one column four empty headings would be the entire view. They come
  // back the moment a card is dragged, which is when the target is needed.
  const dragging = useStore(st => st.boardDrag) !== undefined
  if (tasks.length === 0 && lane !== 'todo' && !dragging) return null

  return (
    <section className={`wt-list-group wt-lane-${lane}${over ? ' over' : ''}`}
             onDragOver={e => {
               if (!e.dataTransfer.types.includes(TASK_MIME)) return
               e.preventDefault()
               e.dataTransfer.dropEffect = 'move'
               setOver(true)
             }}
             onDragLeave={() => setOver(false)}
             onDrop={e => {
               const id = e.dataTransfer.getData(TASK_MIME)
               e.preventDefault()
               setOver(false)
               useStore.setState({ boardDrag: undefined })
               if (!id) return
               // Dropped on the group rather than on a card: land at the end,
               // which is where the eye expects a card released below the last.
               const last = tasks.filter(t => t.id !== id).at(-1)
               applyTasks(dropTask(useStore.getState().tasks, id, lane,
                 last ? { id: last.id, after: true } : undefined))
             }}>
      <div className="wt-list-head">
        <span className="wt-lane-dot" />
        <span className="wt-lane-name">{LANE_LABEL[lane]}</span>
        <span className="wt-lane-count">{tasks.length}</span>
      </div>
      {tasks.map(t => <Card key={t.id} task={t} lane={lane} />)}
      {lane === 'todo' && <NewTask />}
    </section>
  )
}
