// Poke & Prose — dashboard page (federated ESM, no build step).
// Design source: Figma "Michelle Playground" frame 232:2123 (see design/).
// Two-panel layout inside KiroClaw's content area: 450px left rail + preview.

const React = window.__kiroclaw_modules.react
const { useAppApi, useChatLauncher, useNavigate } = window.__kiroclaw_modules['@kiroclaw/app-sdk']
const {
  MousePointerClick, RefreshCw, ChevronDown, ChevronRight,
  Send, Folder, Plus, Monitor, Eye, Pencil, History: HistoryIcon, X,
} = window.__kiroclaw_modules['lucide-react']

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

const CHIP = {
  new:  { label: 'new',        fg: 'var(--warn)',   bg: 'var(--warn-subtle)' },
  sent: { label: 'in progress', fg: 'var(--accent)', bg: 'var(--accent-subtle)' },
  done: { label: 'done',       fg: 'var(--ok)',     bg: 'var(--ok-subtle)' },
}

function Chip({ status }) {
  const c = CHIP[status] || CHIP.new
  return h('span', {
    className: 'text-[11px] px-2 py-[2px] rounded-full font-medium',
    style: { color: c.fg, background: c.bg },
  }, c.label)
}

function RequestCard({ item, done, onFocus, hovered, onHover, onOpenChat, onArchive, onDelete }) {
  const thread = Array.isArray(item.thread) ? item.thread : []
  const lastAgent = thread.slice().reverse().find((m) => m && m.role !== 'user')

  // History cards (done) keep the original full-bleed look; only the sessions
  // list gets the inset themed border + hover actions.
  const containerClass = done
    ? 'py-2 border-b border-border/60'
    : 'py-2 border-b border-border cursor-pointer'

  const iconBtn = (title, icon, handler) => h('button', {
    title,
    onClick: (e) => { e.stopPropagation(); handler(item) },
    className: 'p-1.5 rounded-md text-muted hover:text-text hover:bg-bg-elevated cursor-pointer',
  }, icon)

  return h('div', {
    className: containerClass,
    onClick: done ? undefined : () => onFocus && onFocus(item),
    onMouseEnter: done ? undefined : () => onHover && onHover(item.id),
    onMouseLeave: done ? undefined : () => onHover && onHover(''),
    title: done ? undefined : 'Click to open/close this pin in the preview',
  },
    h('div', { className: 'flex items-center gap-1 text-[11px] text-muted' },
      h('span', null, `#${item.number || '—'}`),
      h('span', null, '·'),
      h('span', { className: 'text-[12px]' }, item.element || `${item.count} elements`),
      !done && item.status === 'new' &&
        h('span', { className: 'w-[6px] h-[6px] rounded-full ml-1', style: { background: 'var(--danger)' } }),
    ),
    h('div', {
      className: 'text-[13px] text-text mt-0.5',
      style: { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
    }, item.comment),
    lastAgent && h('div', {
      className: 'text-[12px] text-muted mt-1 pl-2',
      style: {
        borderLeft: '2px solid var(--border)',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      },
    }, lastAgent.text),
    h('div', { className: 'flex items-center gap-2 mt-1.5' },
      h('span', { className: 'text-[12px] text-muted' }, `Updated ${timeAgo(item.createdAt)}`),
      h(Chip, { status: done ? 'done' : item.status }),
      h('span', { className: 'flex-1' }),
      // Hover-only actions (sessions list only)
      !done && hovered && h('div', { className: 'flex items-center gap-0.5' },
        iconBtn('Open in chat', h(ChatOpenIcon, { size: 14 }), onOpenChat),
        iconBtn('Archive to History', h(ArchiveIcon, { size: 14 }), onArchive),
        iconBtn('Delete request', h(TrashIcon, { size: 14 }), onDelete),
      ),
    ),
  )
}

export default function PokeAndProse() {
  const api = useAppApi()
  const { openChat } = useChatLauncher()
  const navigate = useNavigate()

  const [projects, setProjects] = useState([])
  const [activeId, setActiveId] = useState('')     // backend: which project is served
  const [selectedId, setSelectedId] = useState('') // UI: which project is picked in dropdown
  const [serving, setServing] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [ddOpen, setDdOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [tab, setTab] = useState('requests')
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
  const iframeRef = useRef(null)
  const pendingRef = useRef([])
  useEffect(() => { pendingRef.current = pending }, [pending])
  // Tracks each request's last-seen status so we can auto-reload the preview
  // exactly once when a request for the current app transitions to "done".
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
        `Poke & Prose session for "${label}". Working directory: ${path}\n` +
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

  const sendToAgent = useCallback(async (item, followupText) => {
    const instruction = followupText
      ? `Follow-up on Poke & Prose request #${item.number} (id ${item.id}): "${followupText}".`
      : `Apply Poke & Prose edit request #${item.number} (id ${item.id}): "${item.comment}".`
    const msg =
      `${instruction} ` +
      `Read the payload at ~/.kiroclaw/apps/poke-and-prose/data/queue/${item.id}.json — it includes ` +
      `projectRoot and sourceFile, so edit that file directly (no searching). ` +
      `As you work, POST short progress notes to ${API_BASE}/thread?id=${item.id} with body ` +
      `{"role":"agent","text":"…"} so they show up on the in-preview comment pin. ` +
      `When finished, POST a final note {"role":"agent","text":"done — <what changed>","status":"done"}.`

    // Route into THIS web app's dedicated session (one persistent slot per app
    // path), so all its requests are turns in the same conversation.
    const proj = projects.find((p) => p.id === previewId)
    const path = item.projectRoot || proj?.path || ''
    const label = proj?.name || 'app'
    try {
      if (path) {
        const key = await ensureSlot(path, label)
        await chatApi('/api/chat', 'POST', { message: msg, slot: key, agent: '' })
        setStatus(`Sent #${item.number} → ${label} session.`)
      } else {
        openChat({ message: msg })
        setStatus(`Sent #${item.number} to the agent.`)
      }
      api.post(`${API_BASE}/mark-sent?id=${item.id}`, {}).catch(() => {})
      refresh()
    } catch (err) {
      // Chat API unreachable → fall back to the launcher (host's active session).
      try {
        openChat({ message: msg })
        api.post(`${API_BASE}/mark-sent?id=${item.id}`, {}).catch(() => {})
        setStatus(`Sent #${item.number} (fallback).`)
        refresh()
      } catch { setStatus('Copy this into chat: ' + msg) }
    }
  }, [api, openChat, refresh, projects, previewId, ensureSlot])

  // Messages from the in-preview overlay (overlay → panel channel).
  useEffect(() => {
    async function onMsg(e) {
      const d = e?.data
      if (!d || d.source !== 'kiro-select-to-edit') return

      // New comment captured on an element → create the request, ack the pin,
      // and (comment-instant-send) dispatch it to the agent right away.
      if (d.type === 'capture' && d.payload) {
        try {
          const out = await api.post(`${API_BASE}/submit`, d.payload)
          if (out?.ok) {
            const item = { id: out.id, number: out.number, comment: d.payload.comment }
            postToOverlay({
              type: 'created', clientRef: d.clientRef, id: out.id, number: out.number,
              status: 'sent', element: summarizeEl(d.payload),
              locator: d.payload?.selection?.elements?.[0]?.locator || '',
              thread: [{ role: 'user', text: d.payload.comment }],
            })
            sendToAgent(item)
          } else setStatus(`Capture failed: ${out?.error}`)
        } catch (err) { setStatus(`Capture failed: ${err?.message || err}`) }
        return
      }

      // (Re)send an existing request, optionally with a follow-up comment.
      if (d.type === 'dispatch' && d.id) {
        try {
          if (d.text) {
            await api.post(`${API_BASE}/thread?id=${d.id}`, { role: 'user', text: d.text }).catch(() => {})
          }
          const item = pendingRef.current.find((x) => x.id === d.id) || { id: d.id, number: '', comment: '' }
          sendToAgent(item, d.text)
        } catch (err) { setStatus(`Send failed: ${err?.message || err}`) }
        return
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [api, sendToAgent, postToOverlay, summarizeEl])

  // Push the current preview's requests down to the overlay so it can render
  // pins + threads. Fires whenever the queue or the previewed app changes.
  useEffect(() => {
    if (!previewId) return
    const items = pending.filter((it) => (it.previewUrl || '').includes(`/proxy/${previewId}/`))
    postToOverlay({ type: 'requests', items })
  }, [pending, previewId, postToOverlay])

  const [hoverReqId, setHoverReqId] = useState('')

  // Click a request in the left rail → toggle its pin bubble open/closed.
  const focusPin = useCallback((item) => {
    if (item?.id) postToOverlay({ type: 'toggle', id: item.id })
  }, [postToOverlay])

  // Open the Chat tab AT this app's dedicated session (deterministic slot).
  const openInChat = useCallback((item) => {
    const proj = projects.find((p) => p.id === previewId)
    const path = (item && item.projectRoot) || proj?.path || ''
    navigate(path ? `/chat?sid=${encodeURIComponent(slotKeyFor(path))}` : '/chat')
  }, [navigate, projects, previewId])

  // Archive → move to History (backend /clear moves queue → handled/).
  const archiveReq = useCallback(async (item) => {
    try { await api.post(`${API_BASE}/clear?id=${item.id}`, {}); refresh() }
    catch (err) { setStatus(`Archive failed: ${err?.message || err}`) }
  }, [api, refresh])

  // Delete → permanently remove the request and its pin.
  const deleteReq = useCallback(async (item) => {
    try { await api.post(`${API_BASE}/delete?id=${item.id}`, {}); refresh() }
    catch (err) { setStatus(`Delete failed: ${err?.message || err}`) }
  }, [api, refresh])

  // Auto-reload the preview when a request for the current app finishes, so the
  // agent's edit shows without a manual refresh. Fires only on the →done edge.
  useEffect(() => {
    const prev = seenStatusRef.current
    const cur = {}
    let doneNow = null
    for (const it of pending) {
      cur[it.id] = it.status
      const belongs = (it.previewUrl || '').includes(`/proxy/${previewId}/`)
      if (belongs && it.status === 'done' && prev && prev[it.id] && prev[it.id] !== 'done') {
        doneNow = it
      }
    }
    seenStatusRef.current = cur
    if (prev && doneNow && previewId) {
      setPreviewNonce(Date.now())     // bump iframe src → reload; pins re-anchor on load
      setStatus(`Preview refreshed — #${doneNow.number} done`)
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
  const segBtn = (active) =>
    `flex-1 flex items-center justify-center gap-1.5 h-8 text-[13px] font-bold cursor-pointer transition-all ${
      active ? 'text-accent-fg' : 'text-muted hover:text-text'}`
  const segStyle = (active) =>
    active ? { background: 'var(--accent)', borderRadius: '12px' } : { borderRadius: '12px' }

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
          h('div', { className: 'text-[20px] font-bold text-text-strong leading-tight' }, 'Poke & Prose'),
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
      h('div', { className: 'flex items-center gap-3 px-5 py-2 relative' },
        h('button', {
          onClick: () => { setDdOpen(!ddOpen); setAdding(false) },
          className: 'flex-1 min-w-0 flex items-center gap-2 h-10 px-3 rounded-xl bg-bg-elevated border border-border text-[13px] font-bold text-text cursor-pointer',
        },
          h(Folder, { size: 16, className: 'shrink-0 text-muted' }),
          h('span', { className: 'truncate' }, selected ? selected.name : 'Select a web app…'),
          h(ChevronDown, { size: 16, className: 'ml-auto shrink-0 text-muted' }),
        ),
        connected
          ? h('button', {
              onClick: disconnect,
              title: 'Click again to disconnect',
              className: 'h-10 px-4 text-[13px] font-bold text-text cursor-pointer hover:bg-bg-elevated',
              style: { background: 'transparent', border: '1px solid var(--border)', borderRadius: '12px' },
            }, 'Connected')
          : h('button', {
              onClick: connect, disabled: !selected,
              className: 'h-10 px-4 bg-accent text-accent-fg text-[13px] font-bold cursor-pointer disabled:opacity-40',
              style: { borderRadius: '12px' },
            }, 'Connect'),

        // dropdown panel
        ddOpen && h('div', {
          className: 'absolute left-5 right-5 top-[52px] z-20 rounded-xl border border-border bg-card shadow-lg overflow-hidden',
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
                  h(Folder, { size: 14 }),
                  h('span', { className: 'truncate flex-1' }, p.name),
                  hoverPid === p.id && h('button', {
                    title: 'Remove from list',
                    onClick: (e) => { e.stopPropagation(); removeProject(p) },
                    className: 'flex items-center justify-center text-muted hover:text-text hover:bg-bg-elevated cursor-pointer',
                    style: { width: '22px', height: '22px', borderRadius: '6px' },
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

      // tabs
      h('div', { className: 'px-5 py-2' },
        h('div', { className: 'flex p-1 rounded-2xl bg-bg-elevated border border-border' },
          h('button', {
            onClick: () => setTab('requests'),
            className: segBtn(tab === 'requests'),
            style: segStyle(tab === 'requests'),
          }, h(MousePointerClick, { size: 15 }), 'Edit Requests'),
          h('button', {
            onClick: () => setTab('resources'),
            className: segBtn(tab === 'resources'),
            style: segStyle(tab === 'resources'),
          }, h(Pencil, { size: 14 }), 'Design Resource'),
        ),
      ),

      status && h('div', { className: 'px-5 py-1 text-[11px] text-muted truncate' }, status),

      // tab content
      tab === 'resources'
        ? h('div', { className: 'flex-1 flex items-center justify-center text-muted text-sm' }, 'Coming soon')
        : h('div', { className: 'flex-1 min-h-0 flex flex-col' },
            // requests list (scrolls independently)
            h('div', { className: 'flex-1 min-h-0 overflow-y-auto px-5' },
              pending.length === 0
                ? h('div', { className: 'py-6 text-[13px] text-muted' },
                    'No edit requests yet. Connect a web app, switch the preview to Edit mode, right-click an element, and describe the change.')
                : pending.slice().reverse().map((it) =>
                    h(RequestCard, {
                      key: it.id, item: it, done: false,
                      onFocus: focusPin,
                      hovered: hoverReqId === it.id,
                      onHover: setHoverReqId,
                      onOpenChat: openInChat,
                      onArchive: archiveReq,
                      onDelete: deleteReq,
                    })),
            ),

            // History — pinned to the bottom, expands UPWARD when opened
            h('div', { className: 'shrink-0 border-t border-border' },
              histOpen && history.length > 0 && h('div', {
                className: 'overflow-y-auto px-5 border-b border-border/60',
                style: { maxHeight: '38vh' },
              },
                history.map((it) =>
                  h(RequestCard, { key: it.id, item: it, done: true })),
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
        : h('div', { className: 'flex-1 flex items-center justify-center text-muted text-sm px-10 text-center' },
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
