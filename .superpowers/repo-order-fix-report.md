# Repo section reordering fix

## Root cause (as given)
`moveTo` in `src/renderer/components/sidebar-layout.ts` treated a `repo` drop
target as "ungroup only": `if (target.kind === 'repo') return next`. For a
worktree that's already ungrouped (the default), detaching it is a no-op, so
`moveTo` returned an unchanged layout — the row never moved even though the
insertion line drew correctly.

## Fix
Repo sections now have their own persisted order, `Layout.repoOrder`, keyed by
repo path, the same way groups have `paths`.

### `src/shared/ipc-types.ts`
- Added `repoOrder: Record<string, string[]>` to `Layout`.
- `emptyLayout()` includes `repoOrder: {}`.

### `src/main/config.ts`
- Added `readRepoOrder()`: mirrors `isWellFormedGroup`'s fail-soft contract —
  a missing `repoOrder` becomes `{}`; a non-object value becomes `{}`; a
  per-repo entry that isn't `string[]` is dropped, other repos' entries are
  kept.
- `readLayout` now returns `repoOrder: readRepoOrder(parsed)`.

### `src/renderer/components/sidebar-layout.ts`
- `DropTarget`'s repo variant is now `{ kind: 'repo'; repo: string }`.
- `deriveSections`: a repo section's worktrees are taken in
  `[...repoOrder[repo] ?? [], ...gitOrderPaths]` order, through the existing
  `take()` helper — so `repoOrder` entries win first (ghosts skipped, as
  `take` already does), any worktree absent from `repoOrder` falls back to
  git order at the end, and a path already claimed by a group is never
  re-rendered here (the shared `claimed` set `take()` uses is unchanged).
- `detach()` now also strips the moved path out of every repo's order array,
  not just groups/hidden — so `repoOrder` never lists a path under two repos,
  and a path leaving `repoOrder` for a group/hidden doesn't leave a stale
  *active* duplicate (a genuinely stale entry can still sit unused in another
  repo's array if that repo's own detach never ran — not reachable via
  `moveTo`, since every move calls `detach` once against the full layout).
- `moveTo` with a `repo` target: detaches (as before), then inserts the path
  into `repoOrder[target.repo]` at the position named by the anchor, resolved
  against the post-detach array — the exact same off-by-one-avoiding pattern
  already used for `group` and `hidden` targets.
- `purgePaths` now also filters every `repoOrder` array and drops any key
  that becomes empty (so a disconnected repo's key is actually forgotten,
  not left behind as `[]` forever).

### `src/renderer/components/Sidebar.tsx`
- Repo section's drop target is now `{ kind: 'repo', repo: section.repo }` at
  both `sectionDropProps` and `renderRows`.
- Added `repoPathFor(w)`: resolves a worktree's connected repo path by
  matching `repoLabel(r) === w.repoName` against `repos` — needed because
  `Worktree` only carries `repoName` (a basename), not the full repo path
  `repoOrder` is keyed by. Same match `doDisconnectRepo` already makes in the
  reverse direction.
- `onToggleHidden` (unhiding a row back into its repo section) now passes
  `{ kind: 'repo', repo: repoPathFor(w) }` instead of the old bare
  `{ kind: 'repo' }`.

## Tests added (TDD: written first, confirmed failing, then implemented)

`tests/renderer/sidebar-layout.test.ts` (deriveSections):
- orders a repo section by `repoOrder` before falling back to git order
- appends a worktree absent from `repoOrder` last, in git order
- skips a ghost path in `repoOrder` with no live worktree
- never renders a grouped path in its repo section even if `repoOrder` still lists it

`tests/renderer/sidebar-mutations.test.ts` (moveTo / purgePaths):
- reorders downward within a repo section (the direction the old bug broke)
- reorders upward within a repo section
- drops a path from a group into a repo section at a chosen position
- resolves correctly around a ghost path with no live worktree
- never lists a path under two repos
- `purgePaths` clears purged paths out of `repoOrder`, and drops the now-empty key
- updated the existing `{ kind: 'repo' }` uses to `{ kind: 'repo', repo: '/code/r1' }`
  (shape change only, same assertions)

`tests/main/layout-config.test.ts` (readLayout):
- defaults `repoOrder` to `{}` when absent from an old layout file
- drops malformed `repoOrder` entries rather than throwing (keeps well-formed ones)
- defaults `repoOrder` to `{}` when it isn't an object
- updated existing round-trip/empty/corrupt/malformed-group assertions to
  include `repoOrder: {}` (or the sample's `repoOrder`), since the shape grew

`tests/renderer/store-select-relative.test.ts`:
- seeded layout literal needed `repoOrder: {}` to satisfy the widened `Layout` type (tsc error, not a behavior test).

I confirmed the new tests failed against the pre-fix code (ran
`npx vitest run tests/renderer/sidebar-layout.test.ts tests/renderer/sidebar-mutations.test.ts tests/main/layout-config.test.ts`
before touching `ipc-types.ts`/`config.ts`/`sidebar-layout.ts`: 19 failed, 40
passed) before implementing, then again after: all green.

## Verification

- `npx tsc --noEmit` — clean, no errors.
- `npm test` — **32 test files passed, 373 tests passed**, 0 failed.

Did not launch the Electron app per instructions (`npm run dev` hangs in this
environment).

## Deliberately left alone
- `Worktree` still only carries `repoName` (a basename), not a repo path
  field. Rather than widen that shared type, `repoPathFor` in `Sidebar.tsx`
  resolves it locally against `repos`, matching the existing
  `doDisconnectRepo` pattern.
- Did not touch `reorderGroup`/group reordering, group CRUD, or hidden-section
  logic beyond the `detach()` change needed to keep `repoOrder` consistent —
  out of scope for this bug.
