// Design Tweak — dashboard page (federated ESM, no build step).
// Design source: Figma "Michelle Playground" frame 232:2123 (see design/).
// Two-panel layout inside KiroClaw's content area: 450px left rail + preview.

const React = window.__kirocrew_modules.react
const { useAppApi, useChatLauncher, useNavigate } = window.__kirocrew_modules['@kirocrew/app-sdk']
const {
  RefreshCw, ChevronDown, ChevronRight, Folder, FolderOpen,
  Send, Plus, Monitor, Eye, Pencil, History: HistoryIcon, X,
} = window.__kirocrew_modules['lucide-react']

const { useState, useEffect, useCallback, useMemo, useRef, createElement: h } = React

// lucide dropped brand icons — inline GitHub mark instead.
function GithubIcon({ size = 16 }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24',
    fill: 'currentColor', 'aria-hidden': true,
  }, h('path', {
    d: 'M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.53-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.8 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.67.41.35.77 1.04.77 2.1v3.12c0 .3.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z',
  }))
}

// Inline SVGs for the per-request hover actions (avoids depending on lucide
// icons that may be absent from the host's bundled set).
function ChatOpenIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z' }))
}
function ArchiveIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('rect', { x: 3, y: 4, width: 18, height: 4, rx: 1 }),
    h('path', { d: 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8' }),
    h('path', { d: 'M10 12h4' }))
}
function TrashIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M3 6h18' }),
    h('path', { d: 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2' }),
    h('path', { d: 'M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14' }))
}

const API_BASE = '/apps/poke-and-prose/api'
const DIMS = { desktop: '100%', tablet: '768px', mobile: '390px' }

// --- Per-app chat session (mirrors the host's useChatSession slotting) ---------
// Each web app (by its folder path) maps to ONE deterministic chat slot, so all
// its edit requests land as turns in the SAME session (persists across visits).
// slotKey = "poke-and-prose-" + djb2(path) — identical to the host's hash so the
// slot lines up with what /chat?sid=<key> opens.
const APP_SLOT_PREFIX = 'poke-and-prose'
function djb2Base36(str) {
  let t = 0
  for (let i = 0; i < (str || '').length; i++) t = ((t << 5) - t + str.charCodeAt(i)) | 0
  return (t >>> 0).toString(36)
}
function slotKeyFor(path) { return `${APP_SLOT_PREFIX}-${djb2Base36(path || '')}` }

// Plain same-origin calls to the host chat API — exactly how the dashboard itself
// calls them (no auth header needed; the panel runs in the dashboard origin).
async function chatApi(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(`chat API ${r.status}`)
  const t = await r.text()
  // POST /api/chat answers with an SSE STREAM unless ?ws=1 is set, so the body can
  // legitimately be `data: {...}` rather than JSON. Parsing that threw, and the
  // throw is what diverted a request into a brand-new ad-hoc chat.
  try { return t ? JSON.parse(t) : null } catch { return { ok: true, raw: t } }
}

function timeAgo(iso) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

// Request-level chip. A request's status is derived from its comments, so the
// chip carries the counts too — it is the only place the request row states how
// many comments it holds ("2 done", "1 in progress, 1 done").
function reqChip(req) {
  const comments = req.comments || []
  const n = comments.length
  const done = comments.filter((c) => c.status === 'done').length
  const prog = comments.filter((c) => c.status === 'sent').length
  const queued = n - done - prog

  if (req.status === 'draft') {
    return { label: `${n} not sent`, fg: 'var(--muted)', bg: 'var(--bg-elevated)' }
  }
  if (req.status === 'done') {
    return { label: `${n} done`, fg: 'var(--ok)', bg: 'var(--ok-subtle)' }
  }
  // In flight: name only the groups that actually have members, so a uniform
  // batch reads "2 in progress" rather than "2 in progress, 0 done".
  const parts = []
  if (prog) parts.push(`${prog} in progress`)
  if (done) parts.push(`${done} done`)
  // `queued` should be empty — sending flips every comment to sent — but a
  // comment left at `new` in a sent request would otherwise vanish from the count.
  if (queued) parts.push(`${queued} queued`)
  return {
    label: parts.join(', ') || `${n} in progress`,
    fg: 'var(--accent)',
    bg: 'var(--accent-subtle)',
  }
}

// Per-comment status dot — the Option B "status-forward" cue.
const DOT = {
  new:  'var(--warn)',
  sent: 'var(--accent)',
  done: 'var(--ok)',
}

// Sessions' collapse mechanic: a grid that animates 1fr <-> 0fr, children stay
// mounted (ChatSidebar.tsx FolderBody).
function FolderBody({ open, children }) {
  return h('div', {
    style: {
      display: 'grid',
      gridTemplateRows: open ? '1fr' : '0fr',
      transition: 'grid-template-rows 0.15s ease-out',
    },
  }, h('div', {
    style: {
      overflow: 'hidden',
      visibility: open ? 'visible' : 'hidden',
      padding: open ? '2px' : 0,
    },
    inert: open ? undefined : '',
  }, children))
}

// One comment = one sub-item under a request. Geometry matches a Sessions
// session row (items-start gap-2.5 px-4 py-2 rounded-md).
function CommentRow({ req, c, hovered, onHover, onFocus, onDelete, done }) {
  const thread = Array.isArray(c.thread) ? c.thread : []
  const lastAgent = thread.slice().reverse().find((m) => m && m.role !== 'user')
  const label = `${req.number}.${c.index}`
  const canDelete = !done && req.state === 'draft'

  return h('div', {
    className: 'flex items-start gap-2.5 px-4 py-2 rounded-md cursor-pointer transition-all hover:bg-bg-hover',
    onClick: () => onFocus && onFocus(c),
    onMouseEnter: () => onHover && onHover(c.cid),
    onMouseLeave: () => onHover && onHover(''),
    title: 'Click to open this comment in the preview',
  },
    h('span', {
      className: 'rounded-full shrink-0',
      style: { width: '7px', height: '7px', marginTop: '5px', background: DOT[c.status] || DOT.new },
    }),
    h('div', { className: 'flex-1 min-w-0' },
      h('div', {
        className: 'text-[13px] font-semibold leading-snug text-text',
        style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
      }, c.comment),
      h('div', { className: 'text-[12px] text-muted leading-snug truncate mt-0.5' },
        `${label} · ${c.element || `${c.count} elements`} · ${timeAgo(c.createdAt)}`),
      c.followUpTo && h('div', { className: 'text-[11px] text-muted truncate mt-0.5' },
        `↩ follow-up to ${c.followUpLabel || 'an earlier comment'}`),
      lastAgent && h('div', {
        className: 'text-[12px] text-muted mt-1 pl-2',
        style: {
          borderLeft: '2px solid var(--border)',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        },
      }, lastAgent.text),
    ),
    canDelete && hovered && h('button', {
      title: 'Remove this comment from the draft',
      onClick: (e) => { e.stopPropagation(); onDelete(req, c) },
      className: 'p-1 rounded-md text-muted hover:text-text hover:bg-bg-elevated cursor-pointer shrink-0',
    }, h(TrashIcon, { size: 13 })),
  )
}

// One request = a collapsible group. Row geometry matches a Sessions folder
// header (gap-2 pr-2 py-1.5 pl-13px rounded-md, Folder/FolderOpen glyph swap).
function RequestGroup({
  req, open, onToggle, onSend, sending,
  hoveredCid, onHoverComment, onFocusComment, onDeleteComment,
  onOpenChat, onArchive, onDelete, hovered, onHover, done,
}) {
  const comments = req.comments || []
  const chip = reqChip(req)
  const isDraft = req.status === 'draft'

  const iconBtn = (title, icon, handler) => h('button', {
    title,
    onClick: (e) => { e.stopPropagation(); handler(req) },
    className: 'p-1 rounded-md text-muted hover:text-text hover:bg-bg-elevated cursor-pointer',
  }, icon)

  return h('div', { className: 'mb-0.5' },
    // ---- request row (the "folder") ----
    h('div', {
      className: 'group relative flex items-center gap-2 pr-2 py-1.5 rounded-md text-sm text-muted hover:text-text hover:bg-bg-hover transition-all cursor-pointer',
      style: { paddingLeft: '13px' },
      onClick: () => onToggle(req.id),
      onMouseEnter: () => onHover && onHover(req.id),
      onMouseLeave: () => onHover && onHover(''),
    },
      h(open ? FolderOpen : Folder, { size: 14, className: 'text-muted shrink-0' }),
      h('span', { className: 'flex-1 text-[13px] font-medium text-text truncate text-left' },
        `Request ${req.number}`),
      h('span', {
        className: 'text-[11px] px-2 py-[2px] rounded-full font-medium shrink-0',
        style: { color: chip.fg, background: chip.bg },
      }, chip.label),
      !done && hovered && !isDraft && h('div', { className: 'flex items-center gap-0.5 shrink-0' },
        iconBtn('Open in chat', h(ChatOpenIcon, { size: 13 }), onOpenChat),
        iconBtn('Archive to History', h(ArchiveIcon, { size: 13 }), onArchive),
        iconBtn('Delete request', h(TrashIcon, { size: 13 }), onDelete),
      ),
    ),

    // ---- children: 12px indent + 1px guide rail (Sessions renderFolderBlock) ----
    h(FolderBody, { open },
      h('div', {
        className: 'border-l border-border mb-1 ml-3 pl-1 rounded-bl-md',
      },
        comments.length === 0
          ? h('div', { className: 'px-4 py-2 text-[12px] text-muted' }, 'No comments yet.')
          : comments.map((c) => h(CommentRow, {
              key: c.cid, req, c, done,
              hovered: hoveredCid === c.cid,
              onHover: onHoverComment,
              onFocus: onFocusComment,
              onDelete: onDeleteComment,
            })),

        // ---- send bar: full-width, inside the rail (Option B) ----
        isDraft && comments.length > 0 && h('div', null,
          h('div', { className: 'mx-3 mt-1 border-b border-border' }),
          h('button', {
            onClick: (e) => { e.stopPropagation(); onSend(req) },
            disabled: !!sending,
            className: 'w-full flex items-center justify-center gap-2 px-4 py-2 rounded-md text-[12px] font-semibold cursor-pointer mt-0.5 disabled:cursor-wait',
            style: { background: 'var(--accent)', color: 'var(--accent-fg)', opacity: sending ? 0.7 : 1, border: 0 },
          },
            h(Send, { size: 13 }),
            sending
              ? 'Sending…'
              : `Send ${comments.length} comment${comments.length > 1 ? 's' : ''} as Request ${req.number}`,
          ),
        ),
      ),
    ),
  )
}


export default function DesignTweak() {
  const api = useAppApi()
  const { openChat } = useChatLauncher()
  const navigate = useNavigate()

  const [projects, setProjects] = useState([])
  const [activeId, setActiveId] = useState('')     // backend: which project is served
  const [selectedId, setSelectedId] = useState('') // UI: which project is picked in dropdown
  const [serving, setServing] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [ddOpen, setDdOpen] = useState(false)
  // Mount flag for the dropdown's entrance: false on the first frame, flipped
  // on the next, so the panel transitions in instead of appearing instantly.
  const [ddIn, setDdIn] = useState(false)
  const ddTriggerRef = useRef(null)
  const ddPanelRef = useRef(null)
  const [adding, setAdding] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [devOpen, setDevOpen] = useState(false)     // dev-server editor in the action bar
  const [devDraft, setDevDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const [devError, setDevError] = useState('')
  const [pending, setPending] = useState([])
  const [history, setHistory] = useState([])
  // True until the FIRST projects fetch settles. Without it the panel paints
  // its "no apps registered" empty state during the fetch, so reopening the app
  // (or a reconnect) reads as "my apps are gone" for a beat.
  const [booting, setBooting] = useState(true)
  const [histOpen, setHistOpen] = useState(false)
  const [previewId, setPreviewId] = useState('')
  const [previewNonce, setPreviewNonce] = useState(1)
  // Dimensions are a per-app preference (keyed by project id, persisted).
  const [dimsMap, setDimsMap] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ste_dims_map')) || {} } catch { return {} }
  })
  const [dimsOpen, setDimsOpen] = useState(false)
  const dims = dimsMap[previewId] || 'desktop'
  const setDimsFor = useCallback((pid, k) => {
    if (!pid) return
    setDimsMap((m) => {
      const next = { ...m, [pid]: k }
      try { localStorage.setItem('ste_dims_map', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])
  const [mode, setMode] = useState('preview')
  const [status, setStatus] = useState('')
  const [reqOpen, setReqOpen] = useState({})     // requestId -> expanded?
  const [sendingId, setSendingId] = useState('') // request currently being sent
  const [hoverReqId, setHoverReqId] = useState('')
  const [hoverCid, setHoverCid] = useState('')
  const iframeRef = useRef(null)

  // cid -> { req, comment } across pending AND history, so a follow-up can
  // resolve its origin comment even after that request was archived.
  const commentIndexRef = useRef({})
  useEffect(() => {
    const idx = {}
    for (const req of [...pending, ...history]) {
      for (const c of req.comments || []) idx[c.cid] = { req, comment: c }
    }
    commentIndexRef.current = idx
  }, [pending, history])

  // Label a follow-up by its origin ("3.1") rather than a raw cid.
  const withFollowUpLabels = useCallback((reqs) => reqs.map((req) => ({
    ...req,
    comments: (req.comments || []).map((c) => {
      if (!c.followUpTo) return c
      const origin = commentIndexRef.current[c.followUpTo]
      return origin
        ? { ...c, followUpLabel: `${origin.req.number}.${origin.comment.index}` }
        : c
    }),
  })), [])

  // Dismiss the app selector on an outside click or Escape, and drive its
  // entrance. Uses mousedown (not click) so the menu closes on press rather
  // than waiting for release, and `capture` so a stopPropagation() handler
  // deeper in the tree cannot swallow the dismissal.
  useEffect(() => {
    if (!ddOpen) { setDdIn(false); return }
    const raf = requestAnimationFrame(() => setDdIn(true))
    const onDown = (e) => {
      // "Outside" is anything that is neither the trigger nor the panel — note
      // that the Connect button sits in the same row, so scoping to those two
      // elements (rather than their shared parent) means clicking Connect
      // dismisses the menu too.
      const inTrigger = ddTriggerRef.current?.contains(e.target)
      const inPanel = ddPanelRef.current?.contains(e.target)
      if (!inTrigger && !inPanel) { setDdOpen(false); setAdding(false) }
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { setDdOpen(false); setAdding(false) }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [ddOpen])

  const toggleReq = useCallback((id) => {
    setReqOpen((m) => ({ ...m, [id]: !m[id] }))
  }, [])

  // Tracks each comment's last-seen status so we can auto-reload the preview
  // exactly once when a comment for the current app transitions to "done".
  const seenStatusRef = useRef(null)

  // Which per-app chat slots we've ensured, mapped to the key the HOST returned
  // (it normalizes what we ask for, so we must not assume ours survived).
  const ensuredSlots = useRef(new Map())
  const ensureSlot = useCallback(async (path, label) => {
    const want = slotKeyFor(path)
    if (ensuredSlots.current.has(want)) return ensuredSlots.current.get(want)
    // Slot creation is idempotent: an existing key returns that slot. Listing
    // first was worse than useless — the list holds only OPEN sessions, so a
    // closed one read as absent and we tried to create it again. `title` pins
    // the name so the session can never be auto-titled from a request body.
    let key = want
    try {
      const slot = await chatApi('/api/chat/slots', 'POST',
        { name: want, agent: '', title: `Design Tweak \u2014 ${label}` })
      if (slot?.key) key = slot.key
      if (!slot?.messages?.length) {
        const seed =
          `Design Tweak session for "${label}". Working directory: ${path}\n` +
          `You handle visual edit requests for this web app. For each request, edit the ` +
          `exact source file, then post a one-line summary. Keep responses concise.`
        await chatApi('/api/chat?ws=1', 'POST', { message: seed, slot: key, agent: '' })
      }
    } catch { /* the send below creates the slot on demand anyway */ }
    ensuredSlots.current.set(want, key)
    return key
  }, [])

  // Post a message down into the preview overlay (host → overlay channel).
  const postToOverlay = useCallback((msg) => {
    try {
      iframeRef.current?.contentWindow?.postMessage({ source: 'kiro-ste-host', ...msg }, '*')
    } catch { /* iframe not ready */ }
  }, [])

  const summarizeEl = useCallback((payload) => {
    const el = payload?.selection?.elements?.[0] || {}
    let name = el.tag || ''
    if (el.id) name += `#${el.id}`
    else if (el.classes?.length) name += '.' + el.classes.slice(0, 2).join('.')
    return name
  }, [])

  // Resizable left rail — default 500px, persisted, clamped 360–800.
  const [railW, setRailW] = useState(() => {
    try { return Math.min(800, Math.max(360, parseInt(localStorage.getItem('ste_rail_w'), 10) || 500)) }
    catch { return 500 }
  })
  const dragRef = useRef(null)
  const onDragStart = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = railW
    const onMove = (ev) => {
      const w = Math.min(800, Math.max(360, startW + (ev.clientX - startX)))
      setRailW(w)
    }
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const w = Math.min(800, Math.max(360, startW + (ev.clientX - startX)))
      try { localStorage.setItem('ste_rail_w', String(w)) } catch { /* ignore */ }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [railW])

  const selected = projects.find((p) => p.id === selectedId)
  const connected = !!previewId && previewId === selectedId

  const refresh = useCallback(async () => {
    try {
      const d = await api.get(`${API_BASE}/projects`)
      setProjects(d.projects || [])
      setActiveId(d.activeId || '')
      setServing(!!d.serving)
      setRepoUrl(d.repoUrl || '')
      setSelectedId((cur) => cur || d.activeId || (d.projects?.[0]?.id ?? ''))
      // Restore the last previewed project across visits/restarts — unless the
      // user explicitly disconnected.
      let wasDisconnected = false
      try { wasDisconnected = localStorage.getItem('ste_disconnected') === '1' } catch { /* ignore */ }
      if (d.activeId && !wasDisconnected) setPreviewId((cur) => cur || d.activeId)
    } catch { /* backend warming up */ }
    try {
      const q = await api.get(`${API_BASE}/queue`)
      setPending(Array.isArray(q?.pending) ? q.pending : [])
    } catch { /* ignore */ }
    try {
      const hh = await api.get(`${API_BASE}/history`)
      setHistory(Array.isArray(hh?.history) ? hh.history : [])
    } catch { /* ignore */ }
    // Settled either way: a failed fetch is an answer too, and staying in the
    // loading state forever would be worse than showing the empty state.
    setBooting(false)
  }, [api])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  const switchTo = useCallback((p) => {
    if (!p) return
    setSelectedId(p.id)
    setPreviewId(p.id)               // instant — all projects are always served
    setPreviewNonce(Date.now())
    setMode('preview')
    setStatus('')
    try { localStorage.removeItem('ste_disconnected') } catch { /* ignore */ }
    // Persist as the "last previewed" so it restores after a restart.
    api.post(`${API_BASE}/projects/select`, { id: p.id }).catch(() => {})
  }, [api])

  const connect = useCallback(() => switchTo(selected), [switchTo, selected])

  const disconnect = useCallback(() => {
    setPreviewId('')
    setStatus('')
    try { localStorage.setItem('ste_disconnected', '1') } catch { /* ignore */ }
  }, [])

  const [hoverPid, setHoverPid] = useState('')
  const removeProject = useCallback(async (p) => {
    try {
      const out = await api.post(`${API_BASE}/projects/remove`, { id: p.id })
      if (out?.ok) {
        if (previewId === p.id) setPreviewId('')
        setSelectedId((cur) => (cur === p.id ? '' : cur))
        refresh()
      } else setStatus(`Remove failed: ${out?.error || 'unknown'}`)
    } catch (err) { setStatus(`Remove failed: ${err?.message || err}`) }
  }, [api, previewId, refresh])

  const addProject = useCallback(async (pathArg) => {
    const p = (pathArg || newPath).trim()
    if (!p) return
    try {
      const out = await api.post(`${API_BASE}/projects`, { path: p })
      if (out?.ok) {
        setNewPath(''); setAdding(false); setDdOpen(false)
        switchTo(out.project)   // newly added apps preview immediately
        refresh()
        setStatus(
          out.updated === 'previewUrl' ? `Set dev server for ${out.project.name}.`
            : out.existing ? `Already registered — switched to ${out.project.name}.`
              : out.autoDetected
                ? `Added ${out.project.name} — found its dev server at ${out.project.previewUrl}.`
                : (out.detected || []).length > 1
                  ? `Added ${out.project.name} — ${out.detected.length} dev servers match this folder, so none was assumed. Set one in the dropdown.`
                  : `Added ${out.project.name}${out.project.previewUrl ? ' (dev server)' : ''} — previewing.`,
        )
      } else setStatus(`Add failed: ${out?.error}`)
    } catch (err) { setStatus(`Add failed: ${err?.message || err}`) }
  }, [api, newPath, refresh, switchTo])

  // Picking a folder registers it straight away — the simple flow. Whether it
  // then previews from disk or needs a dev server is the backend's call, and the
  // preview panel says which.
  const pickFolder = useCallback(async () => {
    setStatus('Opening folder picker… (check your Mac for the dialog)')
    try {
      const out = await api.post(`${API_BASE}/pick-folder`, {})
      if (out?.ok && out.path) {
        setStatus('')
        addProject(out.path)
      } else if (out?.canceled) {
        setStatus('')
      } else {
        // picker unavailable (permission denied / non-mac) — fall back to typing
        setAdding(true)
        setStatus(`Picker unavailable (${out?.error || 'unknown'}) — type the path instead.`)
      }
    } catch (err) {
      setAdding(true)
      setStatus(`Picker unavailable (${err?.message || err}) — type the path instead.`)
    }
  }, [api, addProject])

  const selfUpdate = useCallback(async () => {
    setStatus('Pulling latest from GitHub…')
    try {
      const out = await api.post(`${API_BASE}/self-update`, {})
      setStatus(out?.ok ? `Updated to v${out.version}. ${out.note}` : `Update failed: ${out?.error}`)
    } catch (err) { setStatus(`Update failed: ${err?.message || err}`) }
  }, [api])

  // Seal a draft request and hand the WHOLE batch to the agent as one prompt.
  // Seal-on-send: after this the request never accepts comments again, so the
  // next capture opens a fresh draft even while this batch is still running.
  const sendRequest = useCallback(async (req) => {
    const comments = req.comments || []
    if (!comments.length) return
    setSendingId(req.id)
    try {
      const sealed = await api.post(`${API_BASE}/send?id=${req.id}`, {})
      if (!sealed?.ok) {
        setStatus(`Send failed: ${sealed?.error || 'unknown'}`)
        setSendingId('')
        return
      }

      const list = comments.map((c) => {
        const fu = c.followUpTo ? ` (follow-up to comment ${c.followUpTo})` : ''
        return `  ${req.number}.${c.index} [cid ${c.cid}]${fu}\n` +
               `      element: ${c.element || `${c.count} elements`}${c.locator ? `  locator: ${c.locator}` : ''}\n` +
               `      file:    ${c.sourceFile || '(unknown — verify before editing)'}\n` +
               `      change:  "${c.comment}"`
      }).join('\n')

      const msg =
        `Apply Design Tweak request #${req.number} — ${comments.length} comment${comments.length > 1 ? 's' : ''} ` +
        `(request id ${req.id}).\n\n${list}\n\n` +
        `The full payload is at ~/.kirocrew/apps/poke-and-prose/data/queue/${req.id}.json — ` +
        `its \`comments\` array carries each comment's \`cid\`, \`sourceFile\`, and \`selection\`, ` +
        `so edit those files directly without searching.\n` +
        `Work the comments one at a time. For EACH comment, POST progress to ` +
        `${API_BASE}/thread?id=${req.id}&cid=<cid> with {"role":"agent","text":"…"}, ` +
        `and when that comment is finished POST ` +
        `{"role":"agent","text":"done — <what changed>","status":"done"}. ` +
        `Report per comment, not once for the batch — each comment has its own progress bubble.\n` +
        `A comment marked as a follow-up refers to an earlier comment's cid; read that comment's ` +
        `thread in the same file (or in ../handled/) for context before editing.`

      // Route into THIS web app's dedicated session so every request for the
      // app is a turn in the same conversation.
      const proj = projects.find((p) => p.id === previewId)
      const path = req.projectRoot || proj?.path || ''
      const label = proj?.name || 'app'
      // ?ws=1 makes the host answer with JSON; without it the reply is an SSE
      // stream, and the parse error used to be caught and "recovered" by opening a
      // NEW ad-hoc chat — so one request produced two sessions and the app's own
      // per-app session was bypassed. There is deliberately no fallback now: the
      // request is already sealed server-side by /send, so silently dispatching it
      // somewhere else is worse than reporting that it did not go.
      const key = path ? await ensureSlot(path, label) : ''
      if (key) {
        await chatApi('/api/chat?ws=1', 'POST', { message: msg, slot: key, agent: '' })
        setStatus(`Sent Request ${req.number} (${comments.length}) → ${label} session.`)
      } else {
        openChat({ message: msg })          // no folder known — nothing to key a session on
        setStatus(`Sent Request ${req.number} to the agent.`)
      }
      refresh()
    } catch (err) {
      setStatus(`Send failed: ${err?.message || err}`)
    } finally {
      setSendingId('')
    }
  }, [api, openChat, refresh, projects, previewId, ensureSlot])

  // Messages from the in-preview overlay (overlay → panel channel).
  useEffect(() => {
    async function onMsg(e) {
      const d = e?.data
      if (!d || d.source !== 'kiro-select-to-edit') return

      // New comment captured on an element → append it to the project's open
      // draft request and ack the pin. Nothing is dispatched: sending the batch
      // is an explicit, separate step.
      if (d.type === 'capture' && d.payload) {
        try {
          // Stamp the project explicitly. The overlay only knows its own page
          // URL, and the backend can only infer a project from a URL it proxies
          // — so the panel, which knows exactly what it is previewing, says so.
          const out = await api.post(`${API_BASE}/submit`, { ...d.payload, projectId: previewIdRef.current })
          if (out?.ok) {
            postToOverlay({
              type: 'created', clientRef: d.clientRef,
              id: out.cid,                       // overlay keys pins by comment
              number: out.label,                 // "3.1"
              status: 'new', element: summarizeEl(d.payload),
              locator: d.payload?.selection?.elements?.[0]?.locator || '',
              thread: [{ role: 'user', text: d.payload.comment }],
            })
            setReqOpen((m) => ({ ...m, [out.id]: true }))   // reveal the draft
            setStatus(`Added ${out.label} — ${out.commentCount} in Request ${out.number}, not sent yet.`)
            refresh()
          } else setStatus(`Capture failed: ${out?.error}`)
        } catch (err) { setStatus(`Capture failed: ${err?.message || err}`) }
        return
      }

      // Reply typed on an existing comment's pin → a NEW comment in the CURRENT
      // draft, linked back via followUpTo. The already-sent request is untouched.
      if (d.type === 'dispatch' && d.id && d.text) {
        try {
          const origin = commentIndexRef.current[d.id]
          if (!origin) { setStatus('Could not find that comment to follow up on.'); return }
          const out = await api.post(`${API_BASE}/submit`, {
            type: 'visual_edit_request',
            comment: d.text,
            followUpTo: d.id,
            projectId: previewIdRef.current,
            previewUrl: origin.comment.previewUrl,
            selection: { mode: 'single', elements: [{ locator: origin.comment.locator }] },
          })
          if (out?.ok) {
            setReqOpen((m) => ({ ...m, [out.id]: true }))
            setStatus(`Follow-up ${out.label} added to Request ${out.number} — not sent yet.`)
            refresh()
          } else setStatus(`Follow-up failed: ${out?.error}`)
        } catch (err) { setStatus(`Follow-up failed: ${err?.message || err}`) }
        return
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [api, postToOverlay, summarizeEl, refresh])

  // The capture listener below is registered once and lives for the session, so
  // it cannot close over `previewId` — it would capture '' forever and stamp every
  // comment with an empty projectId. A ref is read at call time instead.
  const previewIdRef = useRef(previewId)
  useEffect(() => { previewIdRef.current = previewId }, [previewId])

  const previewProject = projects.find((p) => p.id === previewId)

  // Does a comment belong to the project currently in the preview?
  //
  // Matches on the explicit projectId the backend stamps at capture time. The
  // previewUrl check is only a fallback for comments captured before that field
  // existed — on its own it can recognise nothing but URLs this backend
  // proxies, so a project previewed straight from its dev server (no
  // `/proxy/<id>/` in the URL) would lose every pin on the first reload.
  const belongsToPreview = useCallback((c) => {
    if (!previewId) return false
    if (c?.projectId) return c.projectId === previewId
    // projectRoot is checked BEFORE the URL, because it is the field that stayed
    // correct when projectId did not. Requests captured while the panel held a
    // stale empty previewId have projectId:"" but the right folder — matching on
    // the folder recovers them with no migration of live data.
    const root = previewProject?.path
    if (root && c?.projectRoot) return c.projectRoot === root
    // Last resort, and only ever true for a URL this backend proxies: a project
    // framed from its dev server has no /proxy/<id>/ segment at all.
    return (c?.previewUrl || '').includes(`/proxy/${previewId}/`)
  }, [previewId, previewProject])

  // Requests and history are scoped to the app in the preview. Each web app is a
  // separate body of work with its own dedicated chat session, so mixing them in
  // one list invites sending app A's comment while looking at app B — and makes
  // the panel read as someone else's backlog the moment you switch.
  const myPending = useMemo(
    () => pending.filter((r) => belongsToPreview(r)), [pending, belongsToPreview])
  const myHistory = useMemo(
    () => history.filter((r) => belongsToPreview(r)), [history, belongsToPreview])

  // Where the preview iframe points. A project with a dev-server URL is framed
  // through the overlay-injecting proxy on that URL (the backend resolves it live
  // and hands it back as previewUrl); everything else is proxied from disk. The
  // nonce is the reload lever in both cases.
  const previewSrc = previewProject?.previewUrl
    ? `${previewProject.previewUrl}${previewProject.previewUrl.includes('?') ? '&' : '?'}_t=${previewNonce}`
    : `${API_BASE}/proxy/${previewId}/?_t=${previewNonce}`

  // Preview lifecycle: 'loading' → 'ready', or → 'unreachable'.
  //
  // A blank iframe is ambiguous — still fetching, dev server not started, backend
  // restarting — and a cross-origin frame will not tell us which, so we probe
  // alongside it and report what we can actually establish.
  //
  // Who wins differs by origin, and getting this backwards hides a WORKING
  // preview behind an error card:
  //   • same-origin (our proxy) — `onLoad` is trustworthy, so it wins outright.
  //     The probe only exists to catch a backend that never answers.
  //   • cross-origin (a dev server) — Chrome fires `load` for its own
  //     "can't connect" page, so `onLoad` alone would report success on a dead
  //     server. Readiness there waits for the probe to come back clean.
  const [previewState, setPreviewState] = useState('loading')
  const [previewNote, setPreviewNote] = useState('')
  const isDevServer = !!previewProject?.previewUrl
  const probeOkRef = useRef(false)
  const framedRef = useRef(false)

  // Called by the iframe's onLoad.
  //   • same-origin — the frame rendering IS the answer, whatever the probe said.
  //     It overrides an earlier failure: a preview that visibly works must never
  //     stay behind an error card.
  //   • dev server — Chrome fires load for its own "can't connect" page, so a
  //     frame alone proves nothing; wait for the probe, and never override a
  //     probe that already failed.
  const markFramed = useCallback(() => {
    framedRef.current = true
    setPreviewState((s) => {
      if (!isDevServer) return 'ready'
      if (s === 'unreachable') return s
      return probeOkRef.current ? 'ready' : s
    })
  }, [isDevServer])

  useEffect(() => {
    if (!previewId) return
    setPreviewState('loading')
    setPreviewNote('')
    probeOkRef.current = false
    framedRef.current = false
    let cancelled = false

    const probe = async () => {
      try {
        if (isDevServer) {
          // Opaque by design; all we learn is reachable vs not, which is the
          // only thing that matters for a server we do not control.
          await fetch(previewSrc, { mode: 'no-cors', cache: 'no-store' })
        } else {
          const r = await fetch(previewSrc, { cache: 'no-store' })
          // A 4xx is deliberately NOT an error: the backend answers a missing
          // entry point with a diagnostic page listing the HTML it did find,
          // which is more useful than anything this overlay could say.
          if (r.status >= 500) throw new Error(`backend returned ${r.status}`)
        }
        if (cancelled) return
        probeOkRef.current = true
        if (framedRef.current) setPreviewState((s) => (s === 'unreachable' ? s : 'ready'))
      } catch (err) {
        if (cancelled) return
        // Never let a failed probe overrule a frame that already rendered — a
        // same-origin fetch can fail for reasons the iframe does not care about.
        if (framedRef.current && !isDevServer) return
        setPreviewState('unreachable')
        setPreviewNote(String(err?.message || err))
      }
    }
    void probe()

    // Backstop for a server that accepts the connection but never answers:
    // without it the frame sits blank forever.
    const slow = setTimeout(() => {
      if (cancelled) return
      setPreviewState((s) => (s === 'loading' ? 'unreachable' : s))
      setPreviewNote((n) => n || 'timed out')
    }, 12000)

    return () => { cancelled = true; clearTimeout(slow) }
  }, [previewId, previewSrc, isDevServer])




  // Push the previewed app's COMMENTS down to the overlay as pins. The overlay
  // keys a pin by `id`, so each comment's cid becomes its pin id.
  //
  // Scoped by REQUEST, not by comment: a request belongs to exactly one project by
  // construction, and it carries projectRoot — which comments do not. Filtering
  // per comment therefore dropped every comment of a request whose projectId was
  // written empty, which is precisely the dev-server case, and an empty list makes
  // the overlay remove all pins.
  const pinItems = useMemo(() => {
    const items = []
    for (const req of myPending) {
      for (const c of req.comments || []) {
        items.push({
          id: c.cid,
          number: `${req.number}.${c.index}`,
          status: c.status,
          comment: c.comment,
          element: c.element,
          locator: c.locator,
          thread: c.thread || [],
        })
      }
    }
    return items
  }, [myPending])

  useEffect(() => {
    if (!previewId) return
    postToOverlay({ type: 'requests', items: pinItems })
  }, [pinItems, previewId, postToOverlay])

  // Click a comment in the left rail → toggle its pin bubble open/closed.
  const focusComment = useCallback((c) => {
    if (c?.cid) postToOverlay({ type: 'toggle', id: c.cid })
  }, [postToOverlay])

  // Open the Chat tab AT this app's dedicated session (deterministic slot).
  const openInChat = useCallback((item) => {
    const proj = projects.find((p) => p.id === previewId)
    const path = (item && item.projectRoot) || proj?.path || ''
    navigate(path ? `/chat?sid=${encodeURIComponent(slotKeyFor(path))}` : '/chat')
  }, [navigate, projects, previewId])

  // Archive → move to History (backend /clear moves queue → handled/).
  const archiveReq = useCallback(async (req) => {
    try { await api.post(`${API_BASE}/clear?id=${req.id}`, {}); refresh() }
    catch (err) { setStatus(`Archive failed: ${err?.message || err}`) }
  }, [api, refresh])

  // Delete → permanently remove the request, its comments, and their pins.
  const deleteReq = useCallback(async (req) => {
    try { await api.post(`${API_BASE}/delete?id=${req.id}`, {}); refresh() }
    catch (err) { setStatus(`Delete failed: ${err?.message || err}`) }
  }, [api, refresh])

  // Remove one comment from a draft (backend refuses once the request is sent).
  const deleteComment = useCallback(async (req, c) => {
    try {
      const out = await api.post(`${API_BASE}/delete-comment?id=${req.id}&cid=${c.cid}`, {})
      if (out?.error) setStatus(out.error)
      refresh()
    } catch (err) { setStatus(`Remove failed: ${err?.message || err}`) }
  }, [api, refresh])

  // Auto-reload the preview when a COMMENT for the current app finishes, so the
  // agent's edit shows without a manual refresh. Fires only on the →done edge.
  useEffect(() => {
    const prev = seenStatusRef.current
    const cur = {}
    let doneNow = null
    for (const req of pending) {
      for (const c of req.comments || []) {
        cur[c.cid] = c.status
        const belongs = belongsToPreview(c)
        if (belongs && c.status === 'done' && prev && prev[c.cid] && prev[c.cid] !== 'done') {
          doneNow = { label: `${req.number}.${c.index}` }
        }
      }
    }
    seenStatusRef.current = cur
    if (prev && doneNow && previewId) {
      setPreviewNonce(Date.now())     // bump iframe src → reload; pins re-anchor on load
      setStatus(`Preview refreshed — ${doneNow.label} done`)
    }
  }, [pending, previewId, belongsToPreview])


  // Set or clear the dev-server URL of the project already being previewed.
  // Registering via the add-form only covers NEW projects; this is how an
  // existing one gets pointed at a dev server without re-adding its folder.
  const setDevServer = useCallback(async (url) => {
    if (!previewId) return
    try {
      const out = await api.post(`${API_BASE}/projects/preview-url`, { id: previewId, previewUrl: url })
      if (out?.error) { setStatus(out.error); return }
      setDevOpen(false)
      setDevDraft('')
      await refresh()
      setPreviewNonce(Date.now())      // reload the frame at the new target
      setStatus(url ? `Previewing ${previewProject?.name || 'app'} from ${url}.`
        : `Previewing ${previewProject?.name || 'app'} from disk.`)
    } catch (err) { setStatus(`Failed: ${err?.message || err}`) }
  }, [api, previewId, previewProject, refresh])

  // One click for the common case: find the dev server for THIS project and use
  // it. Falls back to revealing the input when there is nothing unambiguous.
  const useDetectedDevServer = useCallback(async () => {
    if (!previewId) return
    setDetecting(true)
    setStatus('Looking for a dev server…')
    try {
      const out = await api.get(`${API_BASE}/detect-dev-server?id=${encodeURIComponent(previewId)}`)
      if (out?.suggested) { await setDevServer(out.suggested); return }
      if ((out?.candidates || []).length > 1) {
        setDevOpen(true)
        setDevDraft(out.candidates[0].url)
        setStatus(`${out.candidates.length} servers match this folder (${out.candidates.map((c) => c.port).join(', ')}) — pick one.`)
        return
      }
      setDevOpen(true)
      setStatus('No dev server found for this folder — start it, or type the URL.')
    } catch (err) { setStatus(`Detect failed: ${err?.message || err}`) }
    finally { setDetecting(false) }
  }, [api, previewId, setDevServer])

  // Start this project's own dev server, then preview it. Adopts a server the
  // user already has running rather than starting a second one.
  const startDevServer = useCallback(async () => {
    if (!previewId) return
    setStarting(true)
    setDevError('')
    setStatus(`Starting ${previewProject?.devCommand || 'the dev server'}…`)
    try {
      const out = await api.post(`${API_BASE}/dev-server/start?id=${encodeURIComponent(previewId)}`, {})
      if (!out?.ok) {
        setDevError(out?.error || 'Could not start the dev server.')
        setStatus('')
        return
      }
      await refresh()
      setPreviewNonce(Date.now())
      // Report the DEV server's own address, not the injecting proxy's ephemeral
      // port — 5173 is the number the user recognises and can open themselves.
      const shown = out.devUrl || out.url
      setStatus(out.adopted
        ? `Using the dev server already running at ${shown}.`
        : `Dev server running at ${shown}.`)
    } catch (err) { setDevError(String(err?.message || err)) }
    finally { setStarting(false) }
  }, [api, previewId, previewProject, refresh])

  const stopDevServer = useCallback(async () => {
    if (!previewId) return
    try {
      await api.post(`${API_BASE}/dev-server/stop?id=${encodeURIComponent(previewId)}`, {})
      setDevError('')
      await refresh()
      setPreviewNonce(Date.now())
      setStatus('Dev server stopped — previewing from disk.')
    } catch (err) { setStatus(`Stop failed: ${err?.message || err}`) }
  }, [api, previewId, refresh])

  const setEditMode = useCallback((m) => {
    setMode(m)
    try {
      // Resolve the live theme tokens so the in-page overlay matches the host.
      const cs = getComputedStyle(document.documentElement)
      const v = (n) => cs.getPropertyValue(n).trim()
      const theme = {
        accent: v('--accent'), accentFg: v('--accent-fg'), panel: v('--panel'),
        card: v('--card'), bgElevated: v('--bg-elevated'),
        text: v('--text'), textStrong: v('--text-strong'), muted: v('--muted'),
        border: v('--border'), info: v('--info'), ok: v('--ok'), warn: v('--warn'),
      }
      postToOverlay({ type: 'state', editMode: m === 'edit', theme })
    } catch { /* iframe not ready */ }
  }, [postToOverlay])

  // ---------- render ----------
  return h('div', { className: 'flex h-full min-h-0', style: { padding: '12px' } },

    // ================= LEFT RAIL (resizable, bordered container) =================
    h('div', {
      className: 'shrink-0 flex flex-col min-h-0',
      style: {
        width: `${railW}px`,
        border: '1px solid var(--border)',
        borderRadius: '16px',
        overflow: 'hidden',
      },
    },

      // header
      h('div', { className: 'flex items-start gap-3 px-5 pt-4 pb-2' },
        h('div', { className: 'flex-1 min-w-0' },
          h('div', { className: 'text-[20px] font-bold text-text-strong leading-tight' }, 'Design Tweak'),
          h('div', { className: 'text-[12px] text-muted mt-0.5' }, 'Point, describe, and watch the code catch up.'),
        ),
        h('button', {
          title: 'Sync: pull latest app version from GitHub', onClick: selfUpdate,
          className: 'p-2 rounded-md text-muted hover:text-text hover:bg-bg-elevated cursor-pointer',
        }, h(RefreshCw, { size: 16 })),
        h('button', {
          title: 'Open app repo on GitHub',
          onClick: () => repoUrl && window.open(repoUrl, '_blank', 'noopener'),
          className: 'p-2 rounded-md text-muted hover:text-text hover:bg-bg-elevated cursor-pointer',
        }, h(GithubIcon, { size: 16 })),
      ),

      // project dropdown + connect
      h('div', { className: 'flex items-center gap-3 px-5 py-2' },
        // Trigger + panel share a positioned wrapper. The panel is inset to
        // left:0/right:0 of THIS wrapper, so its width is structurally identical
        // to the trigger's — no measurement, and content can never widen it.
        h('div', { className: 'flex-1 min-w-0', style: { position: 'relative' } },
          h('button', {
            ref: ddTriggerRef,
            onClick: () => { setDdOpen(!ddOpen); setAdding(false) },
            className: 'w-full flex items-center gap-2 h-10 px-3 rounded-xl bg-bg-elevated border border-border text-[13px] font-bold text-text cursor-pointer',
          },
            h(Folder, { size: 16, className: 'shrink-0 text-muted' }),
            h('span', { className: 'truncate' }, selected ? selected.name : 'Select a web app…'),
            h(ChevronDown, { size: 16, className: 'ml-auto shrink-0 text-muted' }),
          ),

          // dropdown panel — drops DOWNWARD from the trigger's bottom edge.
          //
          // Geometry lives in inline styles on purpose: this app has no build
          // step and borrows the host's compiled Tailwind, so any class KiroCrew
          // does not itself use was purged. `left-5`, `right-5` and `top-[52px]`
          // are all absent from the host bundle, which left top/left/right at
          // `auto` — the panel then sat at its static position, vertically
          // centred in this items-center row and sized by its own content.
          ddOpen && h('div', {
            ref: ddPanelRef,
            className: 'rounded-xl border border-border bg-card shadow-lg overflow-hidden',
            style: {
              position: 'absolute',
              top: 'calc(100% + 4px)',   // just below the trigger
              left: 0,
              right: 0,                  // == trigger width
              zIndex: 20,
              transformOrigin: 'top center',
              transform: ddIn ? 'translateY(0)' : 'translateY(-4px)',
              opacity: ddIn ? 1 : 0,
              transition: 'transform 130ms cubic-bezier(.4,0,.2,1), opacity 110ms ease-out',
            },
          },
          // scrollable list: 4.5 items visible (item ≈ 40px → 180px)
          h('div', { style: { maxHeight: '180px', overflowY: 'auto' } },
            booting && projects.length === 0
              ? h('div', { className: 'px-3 py-3 flex items-center gap-2 text-[13px] text-muted' },
                  h(RefreshCw, { size: 13, className: 'animate-spin' }), 'Loading…')
              : projects.length === 0
              ? h('div', { className: 'px-3 py-3 text-[13px] text-muted' }, 'No web apps loaded yet.')
              : projects.map((p) => h('div', {
                  key: p.id,
                  onClick: () => { switchTo(p); setDdOpen(false) },
                  onMouseEnter: () => setHoverPid(p.id),
                  onMouseLeave: () => setHoverPid(''),
                  className: `w-full flex items-center gap-2 h-10 px-3 text-left text-[13px] cursor-pointer hover:bg-bg-elevated ${p.id === selectedId ? 'text-text font-bold' : 'text-muted'}`,
                },
                  h(Folder, { size: 14, className: 'shrink-0' }),
                  h('span', { className: 'truncate flex-1' }, p.name),
                  // Tag framework projects: they cannot preview from disk, so the
                  // tag is what tells you a dev server is part of the deal —
                  // shown whether or not one is currently running.
                  (p.needsDevServer || p.previewUrl) && h('span', {
                    title: p.previewUrl
                      ? `Previewing from ${p.previewUrl}`
                      : `Needs a dev server (${p.devCommand || 'no dev script found'})`,
                    className: 'shrink-0 text-[10px] px-1.5 rounded-full',
                    style: {
                      paddingTop: '1px',
                      paddingBottom: '1px',
                      color: p.previewUrl ? 'var(--accent)' : 'var(--muted)',
                      background: p.previewUrl ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                    },
                  }, 'dev'),
                  // Always occupies its 22px, only visibility toggles — a
                  // conditionally-rendered button changed the row's content
                  // width on hover, which shifted the name beside it.
                  h('button', {
                    title: 'Remove from list',
                    onClick: (e) => { e.stopPropagation(); removeProject(p) },
                    className: 'flex items-center justify-center text-muted hover:text-text hover:bg-bg-elevated cursor-pointer',
                    style: {
                      width: '22px', height: '22px', borderRadius: '6px', flex: '0 0 auto',
                      visibility: hoverPid === p.id ? 'visible' : 'hidden',
                    },
                  }, h(X, { size: 14 })),
                )),
          ),
          // pinned below the scroll area
          h('div', { className: 'border-t border-border' },
            adding
              ? h('div', { className: 'flex items-center gap-2 p-2' },
                  h('input', {
                    value: newPath, autoFocus: true,
                    onChange: (e) => setNewPath(e.target.value),
                    onKeyDown: (e) => e.key === 'Enter' && addProject(),
                    placeholder: '/Users/you/Developer/my-app',
                    className: 'flex-1 h-8 px-2 rounded-md bg-bg-elevated border border-border text-[12px] text-text',
                  }),
                  h('button', {
                    onClick: () => addProject(),
                    className: 'h-8 px-3 rounded-md bg-accent text-accent-fg text-[12px] font-bold cursor-pointer',
                  }, 'Add'),
                )
              : h('button', {
                  onClick: pickFolder,
                  title: 'Opens the macOS folder chooser',
                  className: 'w-full flex items-center gap-2 h-10 px-3 text-[13px] text-muted hover:text-text hover:bg-bg-elevated cursor-pointer',
                }, h(Plus, { size: 14 }), 'load new app'),
            ),
          ),
        ),

        connected
          ? h('button', {
              onClick: disconnect,
              title: 'Click again to disconnect',
              className: 'shrink-0 h-10 px-4 text-[13px] font-bold text-text cursor-pointer hover:bg-bg-elevated',
              style: { background: 'transparent', border: '1px solid var(--border)', borderRadius: '12px' },
            }, 'Connected')
          : h('button', {
              onClick: connect, disabled: !selected,
              className: 'shrink-0 h-10 px-4 bg-accent text-accent-fg text-[13px] font-bold cursor-pointer disabled:opacity-40',
              style: { borderRadius: '12px' },
            }, 'Connect'),
      ),

      status && h('div', { className: 'px-5 py-1 text-[11px] text-muted truncate' }, status),

      // request tree + history (nesting mirrors the Sessions folder view)
      h('div', { className: 'flex-1 min-h-0 flex flex-col' },
        // request groups, newest first (scrolls independently)
        h('div', { className: 'flex-1 min-h-0 overflow-y-auto px-2' },
          booting
            ? h('div', { className: 'py-6 px-3 flex items-center gap-2 text-[13px] text-muted' },
                h(RefreshCw, { size: 14, className: 'animate-spin' }), 'Loading your apps…')
            : myPending.length === 0
            ? h('div', { className: 'py-6 px-3 text-[13px] text-muted' },
                !previewId
                  ? 'No web app connected. Pick one in the dropdown above — each app keeps its own requests, history, and chat session.'
                  : `No edit requests for ${previewProject?.name || 'this app'} yet. Switch the preview to Edit mode, right-click an element, and describe the change. Comments collect into a request — send them as one batch when you're done.`)
            : withFollowUpLabels(myPending).slice().reverse().map((req) =>
                h(RequestGroup, {
                  key: req.id, req, done: false,
                  open: reqOpen[req.id] !== false,   // expanded by default
                  onToggle: toggleReq,
                  onSend: sendRequest,
                  sending: sendingId === req.id,
                  hovered: hoverReqId === req.id,
                  onHover: setHoverReqId,
                  hoveredCid: hoverCid,
                  onHoverComment: setHoverCid,
                  onFocusComment: focusComment,
                  onDeleteComment: deleteComment,
                  onOpenChat: openInChat,
                  onArchive: archiveReq,
                  onDelete: deleteReq,
                })),
      ),

      // History — pinned to the bottom, expands UPWARD when opened
      h('div', { className: 'shrink-0 border-t border-border' },
        histOpen && myHistory.length > 0 && h('div', {
          className: 'overflow-y-auto px-2 border-b border-border/60',
          style: { maxHeight: '38vh' },
        },
          withFollowUpLabels(myHistory).map((req) =>
            h(RequestGroup, {
              key: req.id, req, done: true,
              open: reqOpen[req.id] === true,        // collapsed by default
              onToggle: toggleReq,
              hoveredCid: hoverCid,
              onHoverComment: setHoverCid,
              onFocusComment: focusComment,
            })),
        ),
        h('button', {
          onClick: () => setHistOpen(!histOpen),
          className: 'w-full flex items-center gap-2 px-5 text-[15px] font-bold text-text cursor-pointer hover:bg-bg-elevated/40',
          style: { height: '56px' },   // match the right-panel action bar height
        },
          h(histOpen ? ChevronDown : ChevronRight, { size: 16, className: 'text-muted' }),
          h(HistoryIcon, { size: 15, className: 'text-muted' }), 'History',
          h('span', { className: 'text-[12px] text-muted font-normal' }, `(${myHistory.length})`),
        ),
        ),
      ),
    ),

    // drag handle = the gap between panels
    h('div', {
      onMouseDown: onDragStart,
      title: 'Drag to resize',
      className: 'shrink-0 cursor-col-resize',
      style: { width: '11px' },
    }),

    // ================= RIGHT PANEL (bordered container: preview + action bar) =================
    h('div', {
      className: 'flex-1 min-w-0 flex flex-col min-h-0',
      style: { border: '1px solid var(--border)', borderRadius: '16px', overflow: 'hidden' },
    },
      // upper: preview
      // A framework project with no dev server running cannot be previewed from
      // disk at all — its entry script is TypeScript. Rather than frame a page
      // that is guaranteed to come up blank, say so and offer to start it.
      previewId && previewProject?.needsDevServer && !previewProject?.previewUrl
        ? h('div', {
            className: 'flex-1 min-h-0 flex items-center justify-center p-6',
          },
            h('div', {
              className: 'flex flex-col items-start gap-3',
              style: { maxWidth: '460px' },
            },
              h('div', { className: 'text-[15px] font-bold text-text' },
                'This is a web app — it needs a dev server'),
              h('div', { className: 'text-[13px] text-muted leading-snug' },
                previewProject.unbundledEntry
                  ? [
                      'Its entry point is ',
                      h('code', { key: 'e', className: 'text-text' }, previewProject.unbundledEntry),
                      ' — TypeScript/JSX, which a browser cannot run. The files have to be built as they are served, so there is nothing to preview from disk.',
                    ]
                  : 'There is no HTML entry point to serve from disk, so it has to be built and served by its own dev server.',
              ),
              previewProject.devCommand
                ? h('button', {
                    onClick: startDevServer,
                    disabled: starting,
                    className: 'h-9 px-4 rounded-xl text-[13px] font-bold cursor-pointer disabled:cursor-wait',
                    style: { background: 'var(--accent)', color: 'var(--accent-fg)', border: 0 },
                  }, starting ? 'Starting…' : 'Start dev server')
                : h('div', { className: 'text-[12px]', style: { color: 'var(--warn)' } },
                    'No dev script found in package.json — start it yourself, then press Dev server below.'),
              previewProject.devCommand && h('div', { className: 'text-[11px] text-muted' },
                'Runs ', h('code', { key: 'c', className: 'text-text' }, previewProject.devCommand),
                ' in ', h('code', { key: 'p', className: 'text-text' }, previewProject.name),
                '. Hot reload keeps working, and select-to-edit works as usual.'),
              devError && h('div', {
                className: 'text-[12px] leading-snug',
                style: {
                  color: 'var(--danger)', background: 'var(--danger-subtle)',
                  padding: '8px 10px', borderRadius: 8, whiteSpace: 'pre-wrap',
                },
                role: 'alert',
              }, devError),
            ),
          )
        : previewId
        ? h('div', {
            className: 'flex-1 min-h-0 flex items-center justify-center p-3',
            style: { position: 'relative' },
          },
            h('iframe', {
              ref: iframeRef,
              src: previewSrc,
              onLoad: () => {
                markFramed()
                setEditMode(mode)
                postToOverlay({ type: 'requests', items: pinItems })
              },
              title: 'preview',
              style: {
                width: DIMS[dims], height: '100%', border: '1px solid var(--border, #4a464f)',
                borderRadius: 8, background: '#fff', maxWidth: '100%',
              },
              sandbox: 'allow-scripts allow-same-origin allow-forms',
            }),

            // Status layer. Covers the frame while it is blank and explains why,
            // instead of leaving a white rectangle. The iframe stays mounted
            // underneath so it can still finish loading and fire onLoad.
            previewState !== 'ready' && h('div', {
              style: {
                position: 'absolute', inset: '12px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 8, background: 'var(--panel)', textAlign: 'center',
                padding: '24px',
              },
            },
              previewState === 'loading'
                ? h('div', { className: 'flex flex-col items-center gap-2' },
                    h(RefreshCw, { size: 18, className: 'text-muted animate-spin' }),
                    h('div', { className: 'text-[13px] text-text' },
                      `Loading ${previewProject?.name || 'preview'}…`),
                    isDevServer && h('div', { className: 'text-[12px] text-muted' },
                      previewProject.previewUrl),
                  )
                : h('div', { className: 'flex flex-col items-center gap-2', style: { maxWidth: '420px' } },
                    h('div', { className: 'text-[13px] font-bold text-text' },
                      isDevServer ? 'Dev server not reachable' : 'Preview not reachable'),
                    h('div', { className: 'text-[12px] text-muted leading-snug' },
                      isDevServer
                        ? [
                            'Nothing answered at ',
                            h('code', { key: 'u', className: 'text-text' }, previewProject.previewUrl),
                            '. Start the dev server for this project, then retry — or clear its URL to preview the files from disk instead.',
                          ]
                        : 'The app backend did not answer. If you just changed it, toggle Design Tweak off and on in the Apps page.'),
                    previewNote && h('div', { className: 'text-[11px] text-muted' }, `(${previewNote})`),
                    h('button', {
                      onClick: () => setPreviewNonce(Date.now()),
                      className: 'mt-1 h-8 px-3 rounded-md text-[12px] font-bold cursor-pointer',
                      style: { background: 'var(--accent)', color: 'var(--accent-fg)', border: 0 },
                    }, 'Retry'),
                  ),
            ),
          )
        : h('div', {
            className: 'flex-1 flex items-center justify-center text-muted text-sm text-center',
            style: { paddingLeft: '40px', paddingRight: '40px' },   // px-10 is not in the host bundle
          },
            booting
              ? h('div', { className: 'flex flex-col items-center gap-2' },
                  h(RefreshCw, { size: 18, className: 'animate-spin' }),
                  h('div', null, 'Looking for your connected apps…'))
              : 'No web app selected. Pick one in the dropdown — switching is instant.'),

      // bottom: action bar (fixed, 56px — 40px tab pill + 8px gap to each bar edge; matches History header)
      h('div', {
        className: 'shrink-0 flex items-center justify-between px-3',
        style: { height: '56px', borderTop: '1px solid var(--border)' },
      },
        // dimensions selector
        h('div', { className: 'flex items-center gap-1' },
        h('div', { className: 'relative' },
          h('button', {
            onClick: () => setDimsOpen(!dimsOpen),
            className: 'flex items-center gap-2 h-8 px-3 rounded-xl text-[13px] text-text cursor-pointer hover:bg-bg-elevated',
          },
            h(Monitor, { size: 15 }),
            h('span', { className: 'font-bold' }, 'Dimensions:'),
            h('span', null, dims[0].toUpperCase() + dims.slice(1)),
            h(ChevronDown, { size: 14, className: 'text-muted' }),
          ),
          dimsOpen && h('div', {
            className: 'rounded-xl border border-border bg-card shadow-lg overflow-hidden',
            style: { position: 'absolute', bottom: '40px', left: 0, minWidth: '180px', zIndex: 30 },
          },
            Object.keys(DIMS).map((k) => h('button', {
              key: k,
              onClick: () => { setDimsFor(previewId, k); setDimsOpen(false) },
              className: `block w-full text-left px-4 h-9 text-[13px] cursor-pointer hover:bg-bg-elevated ${k === dims ? 'text-text font-bold' : 'text-muted'}`,
            }, k[0].toUpperCase() + k.slice(1) + (k === 'desktop' ? '' : ` (${DIMS[k]})`))),
          ),
        ),

        // Dev-server control. Sits beside Dimensions because that is where you
        // are when a preview looks wrong — the add-form only covers new projects.
        previewId && h('div', { className: 'relative' },
          previewProject?.previewUrl && !devOpen
            ? h('div', { className: 'flex items-center gap-1 h-8 pl-2 pr-1 rounded-xl', style: { background: 'var(--accent-subtle)' } },
                h('span', { className: 'text-[12px]', style: { color: 'var(--accent)' } },
                  previewProject.previewUrl.replace(/^https?:\/\//, '')),
                h('button', {
                  title: 'Preview from disk instead',
                  onClick: () => setDevServer(''),
                  className: 'p-1 rounded-md cursor-pointer',
                  style: { color: 'var(--accent)' },
                }, h(X, { size: 13 })),
              )
            : !devOpen
              ? h('button', {
                  onClick: useDetectedDevServer,
                  disabled: detecting,
                  title: 'Preview this project from its running dev server (keeps hot reload working)',
                  className: 'flex items-center gap-2 h-8 px-3 rounded-xl text-[13px] text-muted hover:text-text hover:bg-bg-elevated cursor-pointer disabled:cursor-wait',
                }, h(Eye, { size: 15 }), detecting ? 'Looking…' : 'Dev server')
              : h('div', { className: 'flex items-center gap-1' },
                  h('input', {
                    value: devDraft, autoFocus: true,
                    onChange: (e) => setDevDraft(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') setDevServer(devDraft.trim())
                      if (e.key === 'Escape') { setDevOpen(false); setDevDraft('') }
                    },
                    placeholder: 'http://localhost:5173',
                    className: 'h-8 px-2 rounded-md bg-bg-elevated border border-border text-[12px] text-text',
                    style: { width: '190px' },
                  }),
                  h('button', {
                    onClick: () => setDevServer(devDraft.trim()),
                    className: 'h-8 px-2 rounded-md text-[12px] font-bold cursor-pointer',
                    style: { background: 'var(--accent)', color: 'var(--accent-fg)', border: 0 },
                  }, 'Use'),
                  h('button', {
                    onClick: () => { setDevOpen(false); setDevDraft('') },
                    className: 'h-8 px-2 rounded-md text-[12px] text-muted hover:text-text cursor-pointer',
                  }, 'Cancel'),
                ),
        ),
        ),
        // refresh + preview/edit toggle
        h('div', { className: 'flex items-center gap-2' },
          h('button', {
            title: 'Refresh preview',
            onClick: () => previewId && setPreviewNonce(Date.now()),
            disabled: !previewId,
            className: 'p-2 rounded-md text-muted hover:text-text hover:bg-bg-elevated cursor-pointer disabled:opacity-40',
          }, h(RefreshCw, { size: 15 })),
          h('div', {
            className: 'flex items-center gap-1',
            style: {
              background: 'rgba(0,0,0,0.25)',   // theme-agnostic "darker" recessed track
              borderRadius: '14px', border: '1px solid var(--border)', padding: '4px',
            },
          },
            h('button', {
              onClick: () => setEditMode('preview'),
              className: `flex items-center justify-center gap-1.5 h-8 px-3 text-[13px] font-bold cursor-pointer transition-all ${mode === 'preview' ? 'text-accent-fg' : 'text-text hover:text-text'}`,
              style: { borderRadius: '10px', background: mode === 'preview' ? 'var(--accent)' : 'transparent' },
            }, h(Eye, { size: 14 }), 'Preview'),
            h('button', {
              onClick: () => setEditMode('edit'),
              className: `flex items-center justify-center gap-1.5 h-8 px-3 text-[13px] font-bold cursor-pointer transition-all ${mode === 'edit' ? 'text-accent-fg' : 'text-text hover:text-text'}`,
              style: { borderRadius: '10px', background: mode === 'edit' ? 'var(--accent)' : 'transparent' },
            }, h(Pencil, { size: 14 }), 'Edit'),
          ),
        ),
      ),
    ),
  )
}
