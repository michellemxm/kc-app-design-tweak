// Design Tweak — dashboard page (federated ESM, no build step).
// Design source: Figma "Michelle Playground" frame 232:2123 (see design/).
// Two-panel layout inside KiroClaw's content area: 450px left rail + preview.

const React = window.__kirocrew_modules.react
const { useAppApi, useChatLauncher, useNavigate } = window.__kirocrew_modules['@kirocrew/app-sdk']
const {
  RefreshCw, ChevronDown, ChevronRight, Folder, FolderOpen,
  Send, Plus, Monitor, Eye, Pencil, History: HistoryIcon, X,
} = window.__kirocrew_modules['lucide-react']

const { useState, useEffect, useCallback, useRef, createElement: h } = React

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
  return t ? JSON.parse(t) : null
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
  const [pending, setPending] = useState([])
  const [history, setHistory] = useState([])
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

  // Which per-app chat slots we've already ensured exist (this panel session).
  const ensuredSlots = useRef(new Set())
  const ensureSlot = useCallback(async (path, label) => {
    const key = slotKeyFor(path)
    if (ensuredSlots.current.has(key)) return key
    let slots = []
    try { slots = await chatApi('/api/chat/slots', 'GET') } catch { /* ignore */ }
    const exists = Array.isArray(slots) && slots.some((s) => s.key === key)
    if (!exists) {
      await chatApi('/api/chat/slots', 'POST', { name: key, agent: '' })
      const seed =
        `Design Tweak session for "${label}". Working directory: ${path}\n` +
        `You handle visual edit requests for this web app. For each request, edit the ` +
        `exact source file, then post a one-line summary. Keep responses concise.`
      try { await chatApi('/api/chat', 'POST', { message: seed, slot: key, agent: '' }) } catch { /* ignore */ }
    }
    ensuredSlots.current.add(key)
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
        setStatus(out.existing ? `Already registered — switched to ${out.project.name}.` : `Added ${out.project.name} — previewing.`)
      } else setStatus(`Add failed: ${out?.error}`)
    } catch (err) { setStatus(`Add failed: ${err?.message || err}`) }
  }, [api, newPath, refresh, switchTo])

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
      try {
        if (path) {
          const key = await ensureSlot(path, label)
          await chatApi('/api/chat', 'POST', { message: msg, slot: key, agent: '' })
          setStatus(`Sent Request ${req.number} (${comments.length}) → ${label} session.`)
        } else {
          openChat({ message: msg })
          setStatus(`Sent Request ${req.number} to the agent.`)
        }
      } catch {
        // Chat API unreachable → fall back to the host's active session.
        openChat({ message: msg })
        setStatus(`Sent Request ${req.number} (fallback).`)
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
          const out = await api.post(`${API_BASE}/submit`, d.payload)
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

  // Push the previewed app's COMMENTS down to the overlay as pins. The overlay
  // keys a pin by `id`, so each comment's cid becomes its pin id.
  useEffect(() => {
    if (!previewId) return
    const items = []
    for (const req of pending) {
      for (const c of req.comments || []) {
        if (!(c.previewUrl || '').includes(`/proxy/${previewId}/`)) continue
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
    postToOverlay({ type: 'requests', items })
  }, [pending, previewId, postToOverlay])

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
        const belongs = (c.previewUrl || '').includes(`/proxy/${previewId}/`)
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
  }, [pending, previewId])


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
            projects.length === 0
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
                  h('button', { onClick: () => addProject(), className: 'h-8 px-3 rounded-md bg-accent text-accent-fg text-[12px] font-bold cursor-pointer' }, 'Add'),
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
          pending.length === 0
            ? h('div', { className: 'py-6 px-3 text-[13px] text-muted' },
                'No edit requests yet. Connect a web app, switch the preview to Edit mode, right-click an element, and describe the change. Comments collect into a request — send them as one batch when you\'re done.')
            : withFollowUpLabels(pending).slice().reverse().map((req) =>
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
        histOpen && history.length > 0 && h('div', {
          className: 'overflow-y-auto px-2 border-b border-border/60',
          style: { maxHeight: '38vh' },
        },
          withFollowUpLabels(history).map((req) =>
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
          h('span', { className: 'text-[12px] text-muted font-normal' }, `(${history.length})`),
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
      previewId
        ? h('div', { className: 'flex-1 min-h-0 flex items-center justify-center p-3' },
            h('iframe', {
              ref: iframeRef,
              src: `${API_BASE}/proxy/${previewId}/?_t=${previewNonce}`,
              onLoad: () => {
                setEditMode(mode)
                const items = pending.filter((it) => (it.previewUrl || '').includes(`/proxy/${previewId}/`))
                postToOverlay({ type: 'requests', items })
              },
              title: 'preview',
              style: {
                width: DIMS[dims], height: '100%', border: '1px solid var(--border, #4a464f)',
                borderRadius: 8, background: '#fff', maxWidth: '100%',
              },
              sandbox: 'allow-scripts allow-same-origin allow-forms',
            }),
          )
        : h('div', {
            className: 'flex-1 flex items-center justify-center text-muted text-sm text-center',
            style: { paddingLeft: '40px', paddingRight: '40px' },   // px-10 is not in the host bundle
          },
            'No web app selected. Pick one in the dropdown — switching is instant.'),

      // bottom: action bar (fixed, 56px — 40px tab pill + 8px gap to each bar edge; matches History header)
      h('div', {
        className: 'shrink-0 flex items-center justify-between px-3',
        style: { height: '56px', borderTop: '1px solid var(--border)' },
      },
        // dimensions selector
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
