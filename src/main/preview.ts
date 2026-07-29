import { protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { resolveInWorktree } from './files'

// Serves files out of a worktree over wtm-preview:// so the renderer can frame an
// HTML file from disk. URL shape: wtm-preview://wt/<root-id>/<worktree-relative path>.
// Putting the root id in the first path segment (rather than the host, which the
// URL parser lowercases) keeps every relative asset URL inside the page resolving
// against the same worktree.
//
// Roots are registered by previewUrl() instead of encoded into the URL, so the
// protocol handler can only ever reach a worktree the app has explicitly opened.
const roots = new Map<string, string>()
let nextId = 0

// Returns a URL that renders `file` from `worktreePath`. Throws if the file
// escapes the worktree.
export function previewUrl(worktreePath: string, file: string): string {
  resolveInWorktree(worktreePath, file)  // containment check; throws otherwise
  let id = [...roots].find(([, root]) => root === worktreePath)?.[0]
  if (!id) { id = String(nextId++); roots.set(id, worktreePath) }
  // Encode each segment so spaces and other path oddities survive the round trip.
  const rel = file.split('/').map(encodeURIComponent).join('/')
  return `wtm-preview://wt/${id}/${rel}`
}

export function registerPreviewProtocol() {
  protocol.handle('wtm-preview', async (req) => {
    const { pathname } = new URL(req.url)
    // pathname is "/<id>/<rel...>"; a page requesting a root-absolute asset
    // ("/style.css") lands here with no id and is refused rather than reaching
    // outside a worktree.
    const [, id, ...rest] = pathname.split('/')
    const root = roots.get(id)
    if (!root || rest.length === 0) return new Response('Not found', { status: 404 })
    let abs: string
    try { abs = resolveInWorktree(root, rest.map(decodeURIComponent).join('/')) }
    catch { return new Response('Forbidden', { status: 403 }) }
    const res = await net.fetch(pathToFileURL(abs).toString())
    // no-store so the renderer can load the base URL (no cache-busting query) and
    // still get current disk content — the preview must never show a stale page.
    const headers = new Headers(res.headers)
    headers.set('cache-control', 'no-store')
    return new Response(res.body, { status: res.status, headers })
  })
}
