// Select to Edit — dashboard page (federated ESM, no build step).
// Loaded by AppHost via import('/apps/poke-and-prose/ui/index.mjs').
// Resolves React + app-sdk + icons from the host import map (window.__kiroclaw_modules),
// exactly like the shipping demo-app / agent-worlds apps.

const React = window.__kiroclaw_modules.react
const { useAppApi, useChatLauncher } = window.__kiroclaw_modules['@kiroclaw/app-sdk']
const { MousePointerClick, RefreshCw, Send } = window.__kiroclaw_modules['lucide-react']

const { useState, useEffect, useCallback, useRef, createElement: h } = React

const API_BASE = '/apps/poke-and-prose/api'
const LS_KEY = 'ste_active_url'  // persist the active preview target across navigation

function StatCard({ label, value, accent }) {
  return h('div', { className: 'bg-card rounded-md px-4 py-3.5 border border-border shadow-[inset_0_1px_0_var(--card-hl)]' },
    h('div', { className: 'text-muted text-[13px] font-medium uppercase tracking-[.04em]' }, label),
    h('div', { className: `text-2xl font-bold mt-1.5 tracking-tight leading-none ${accent ? 'text-accent' : ''}` }, String(value ?? '—')),
  )
}

function SelectToEdit() {
  const api = useAppApi()
  const { openChat } = useChatLauncher()
  const [url, setUrl] = useState('')
  const [loadedUrl, setLoadedUrl] = useState('')
  const [pending, setPending] = useState([])
  const [status, setStatus] = useState('')
  const iframeRef = useRef(null)

  const refreshQueue = useCallback(async () => {
    try {
      const data = await api.get(`${API_BASE}/queue`)
      setPending(Array.isArray(data?.pending) ? data.pending : [])
    } catch {
      /* backend may still be warming up */
    }
  }, [api])

  // Poll the queue.
  useEffect(() => {
    refreshQueue()
    const t = setInterval(refreshQueue, 4000)
    return () => clearInterval(t)
  }, [refreshQueue])

  // Receive selections postMessage'd from the injected script inside the iframe.
  useEffect(() => {
    async function onMsg(e) {
      const d = e?.data
      if (!d || d.source !== 'kiro-select-to-edit' || !d.payload) return
      try {
        const out = await api.post(`${API_BASE}/submit`, d.payload)
        if (out?.ok) {
          setStatus(`Captured "${d.payload.comment}" → queued (${out.id})`)
          refreshQueue()
        } else {
          setStatus(`Capture failed: ${out?.error || 'unknown error'}`)
        }
      } catch (err) {
        setStatus(`Capture failed: ${err?.message || err}`)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [api, refreshQueue])

  const startPreview = useCallback(async (target) => {
    const u = (target || url || '').trim()
    if (!u) return
    try {
      const out = await api.post(`${API_BASE}/source`, { value: u })
      if (out?.ok) {
        // Same-origin proxy URL — satisfies the dashboard CSP (frame-src 'self').
        setLoadedUrl(`${API_BASE}/proxy/?_t=${Date.now()}`)
        try { localStorage.setItem(LS_KEY, u) } catch { /* ignore */ }
        setStatus(out.mode === 'folder'
          ? `Serving folder ${out.root} — overlay injected; edits will target this project.`
          : `Proxying ${out.target || u} — overlay injected.`)
      } else {
        setStatus(`View failed: ${out?.error || 'unknown error'}`)
      }
    } catch (err) {
      setStatus(`View failed: ${err?.message || err}`)
    }
  }, [api, url])

  const endPreview = useCallback(() => {
    setLoadedUrl('')
    try { localStorage.removeItem(LS_KEY) } catch { /* ignore */ }
    setStatus('Preview ended.')
  }, [])

  // Restore the preview after navigating away and back (the page remounts and
  // loses React state, but the backend proxy target + localStorage let us re-arm).
  useEffect(() => {
    let saved = ''
    try { saved = localStorage.getItem(LS_KEY) || '' } catch { /* ignore */ }
    if (saved) {
      setUrl(saved)
      startPreview(saved)
    }
    // run once on mount
  }, []) // eslint-disable-line

  const applyLatest = useCallback(() => {
    const latest = pending[pending.length - 1]
    if (!latest) return
    const msg =
      `Apply the pending Select-to-Edit request (id ${latest.id}): "${latest.comment}". ` +
      `Read the payload at ~/.kiroclaw/apps/poke-and-prose/data/queue/${latest.id}.json — ` +
      `it includes projectRoot and sourceFile, so edit that file directly (no searching), ` +
      `then clear the request (POST ${API_BASE}/clear?id=${latest.id}).`
    try {
      openChat({ message: msg })
      setStatus(`Sent request ${latest.id} to the agent.`)
    } catch {
      setStatus('Copy this into chat: ' + msg)
    }
  }, [openChat, pending])

  return h('div', { className: 'flex flex-col h-full min-h-0' },
    // Header
    h('div', { className: 'px-6 pt-4 pb-3 flex items-end justify-between gap-4' },
      h('div', null,
        h('div', { className: 'text-2xl font-bold tracking-tight text-text-strong flex items-center gap-2' },
          h(MousePointerClick, { size: 22 }), 'Poke & Prose'),
        h('div', { className: 'text-muted text-sm mt-1' },
          'Point at elements in your live app; type a comment; the agent edits the source.'),
      ),
      h('button', {
        className: 'px-2.5 py-1 rounded-md border border-border bg-transparent text-muted hover:text-text hover:border-border-strong text-[13px] cursor-pointer transition-all inline-flex items-center gap-1.5',
        onClick: refreshQueue,
      }, h(RefreshCw, { size: 14 }), 'Refresh'),
    ),

    h('div', { className: 'px-6 pb-8 overflow-y-auto flex-1 min-h-0' },
      // Stats
      h('div', { className: 'grid gap-3.5 grid-cols-[repeat(auto-fit,minmax(150px,1fr))] mb-6' },
        h(StatCard, { label: 'Pending requests', value: pending.length, accent: pending.length > 0 }),
        h(StatCard, { label: 'Preview', value: loadedUrl ? 'Connected' : 'Idle' }),
      ),

      // Preview card
      h('div', { className: 'border border-border bg-card rounded-lg p-5 shadow-sm' },
        h('h3', { className: 'text-sm font-semibold tracking-tight text-text-strong mb-3.5' }, 'Preview'),
        h('div', { className: 'flex gap-2 mb-3' },
          h('input', {
            value: url,
            onChange: (e) => setUrl(e.target.value),
            placeholder: '/Users/you/Developer/my-app   (or http://localhost:5173)',
            className: 'flex-1 px-3 py-2 rounded-md bg-bg-elevated border border-border text-sm text-text',
          }),
          loadedUrl
            ? h('button', {
                onClick: endPreview,
                className: 'px-3 py-2 rounded-md border border-border text-text hover:border-border-strong text-sm font-semibold cursor-pointer',
              }, 'End preview')
            : h('button', {
                onClick: () => startPreview(),
                className: 'px-3 py-2 rounded-md bg-accent text-white text-sm font-semibold cursor-pointer',
              }, 'View'),
        ),
        status && h('div', { className: 'text-[12px] text-muted mb-2' }, status),
        h('div', {
          className: 'rounded-lg overflow-hidden border border-border bg-bg-elevated',
          style: { height: 520 },
        },
          loadedUrl
            ? h('iframe', {
                ref: iframeRef,
                src: loadedUrl,
                title: 'preview',
                style: { width: '100%', height: '100%', border: 0 },
                sandbox: 'allow-scripts allow-same-origin allow-forms',
              })
            : h('div', { className: 'h-full grid place-items-center text-sm text-muted px-8 text-center' },
                'Enter your dev server URL and press Load. Add the selection script to your dev build (see README) to enable pointing.'),
        ),
      ),

      // Pending requests card
      h('div', { className: 'border border-border bg-card rounded-lg p-5 shadow-sm mt-6' },
        h('div', { className: 'flex items-center justify-between mb-1' },
          h('h3', { className: 'text-sm font-semibold tracking-tight text-text-strong' }, 'Pending edit requests'),
          h('button', {
            onClick: applyLatest,
            disabled: pending.length === 0,
            className: 'px-3 py-1.5 rounded-md bg-accent disabled:opacity-40 text-white text-xs font-semibold cursor-pointer inline-flex items-center gap-1.5',
          }, h(Send, { size: 13 }), 'Send latest to agent'),
        ),
        pending.length === 0
          ? h('div', { className: 'text-sm text-muted mt-2' },
              'No requests yet. Toggle select mode in the preview (◎ button or Alt+S), right-click an element, and type a comment.')
          : h('div', { className: 'space-y-2 mt-3' },
              ...pending.map((p) =>
                h('div', { key: p.id, className: 'text-sm border border-border rounded-md px-3 py-2 bg-bg-elevated' },
                  h('div', { className: 'text-text font-medium' }, p.comment),
                  h('div', { className: 'text-[12px] text-muted' },
                    `${p.mode} · ${p.count} element${p.count === 1 ? '' : 's'} · ${p.previewUrl}`),
                )
              )
            ),
      ),
    ),
  )
}

export default SelectToEdit
