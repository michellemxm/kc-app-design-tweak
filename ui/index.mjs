// Poke & Prose — dashboard page (federated ESM, no build step).
// Design source: Figma "Michelle Playground" frame 232:2123 (see design/).
// Two-panel layout inside KiroClaw's content area: 450px left rail + preview.

const React = window.__kiroclaw_modules.react
const { useAppApi, useChatLauncher } = window.__kiroclaw_modules['@kiroclaw/app-sdk']
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

const API_BASE = '/apps/poke-and-prose/api'
const DIMS = { desktop: '100%', tablet: '768px', mobile: '390px' }

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

function RequestCard({ item, done, onSend }) {
  return h('div', { className: 'py-2 border-b border-border/60' },
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
    h('div', { className: 'flex items-center gap-2 mt-1.5' },
      h('span', { className: 'text-[12px] text-muted' }, `Updated ${timeAgo(item.createdAt)}`),
      h(Chip, { status: done ? 'done' : item.status }),
      h('span', { className: 'flex-1' }),
      !done && h('button', {
        title: 'Send to agent',
        onClick: () => onSend(item),
        className: 'p-1.5 rounded-md text-muted hover:text-text hover:bg-bg-elevated cursor-pointer',
      }, h(Send, { size: 14 })),
    ),
  )
}

export default function PokeAndProse() {
  const api = useAppApi()
  const { openChat } = useChatLauncher()

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

  // Captures from the overlay inside the iframe.
  useEffect(() => {
    async function onMsg(e) {
      const d = e?.data
      if (!d || d.source !== 'kiro-select-to-edit' || !d.payload) return
      try {
        const out = await api.post(`${API_BASE}/submit`, d.payload)
        setStatus(out?.ok ? `Captured "${d.payload.comment}"` : `Capture failed: ${out?.error}`)
        refresh()
      } catch (err) { setStatus(`Capture failed: ${err?.message || err}`) }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [api, refresh])

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

  const sendToAgent = useCallback((item) => {
    const msg =
      `Apply the pending Poke & Prose edit request (id ${item.id}, #${item.number}): "${item.comment}". ` +
      `Read the payload at ~/.kiroclaw/apps/poke-and-prose/data/queue/${item.id}.json — it includes ` +
      `projectRoot and sourceFile, so edit that file directly (no searching), then clear the request ` +
      `(POST ${API_BASE}/clear?id=${item.id}).`
    try {
      openChat({ message: msg })
      api.post(`${API_BASE}/mark-sent?id=${item.id}`, {}).catch(() => {})
      setStatus(`Sent #${item.number} to the agent.`)
      refresh()
    } catch { setStatus('Copy this into chat: ' + msg) }
  }, [api, openChat, refresh])

  const setEditMode = useCallback((m) => {
    setMode(m)
    try {
      // Resolve the live theme tokens so the in-page overlay matches KiroClaw.
      const cs = getComputedStyle(document.documentElement)
      const theme = {
        accent: cs.getPropertyValue('--accent').trim(),
        panel: cs.getPropertyValue('--panel').trim(),
        text: cs.getPropertyValue('--text').trim(),
        border: cs.getPropertyValue('--border').trim(),
        info: cs.getPropertyValue('--info').trim(),
      }
      iframeRef.current?.contentWindow?.postMessage(
        { source: 'kiro-ste-host', editMode: m === 'edit', theme }, '*')
    } catch { /* iframe not ready */ }
  }, [])

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
                    h(RequestCard, { key: it.id, item: it, done: false, onSend: sendToAgent })),
            ),

            // History — pinned to the bottom, expands UPWARD when opened
            h('div', { className: 'shrink-0 border-t border-border' },
              histOpen && history.length > 0 && h('div', {
                className: 'overflow-y-auto px-5 border-b border-border/60',
                style: { maxHeight: '38vh' },
              },
                history.map((it) =>
                  h(RequestCard, { key: it.id, item: it, done: true, onSend: () => {} })),
              ),
              h('button', {
                onClick: () => setHistOpen(!histOpen),
                className: 'w-full flex items-center gap-2 px-5 py-3 text-[15px] font-bold text-text cursor-pointer hover:bg-bg-elevated/40',
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
              onLoad: () => setEditMode(mode),
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

      // bottom: action bar (fixed, 44px — same as collapsed History header)
      h('div', {
        className: 'shrink-0 flex items-center justify-between px-3',
        style: { height: '44px', borderTop: '1px solid var(--border)' },
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
        // preview / edit toggle
        h('div', { className: 'flex p-0.5 rounded-xl', style: { background: 'var(--panel)' } },
          h('button', {
            onClick: () => setEditMode('preview'),
            className: segBtn(mode === 'preview') + ' px-3',
            style: segStyle(mode === 'preview'),
          }, h(Eye, { size: 14 }), 'Preview'),
          h('button', {
            onClick: () => setEditMode('edit'),
            className: segBtn(mode === 'edit') + ' px-3',
            style: segStyle(mode === 'edit'),
          }, h(Pencil, { size: 14 }), 'Edit'),
        ),
      ),
    ),
  )
}
