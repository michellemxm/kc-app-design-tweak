/**
 * Preview lifecycle: loading -> ready, or -> unreachable.
 *
 * A blank iframe is ambiguous (still fetching / dev server not started / backend
 * restarting) and a cross-origin frame will not say which, so the panel probes
 * alongside it. Mirrors the logic in ui/index.mjs.
 *
 * WHO WINS differs by origin, and getting it backwards hides a working preview
 * behind an error card:
 *   same-origin  — onLoad is trustworthy and wins outright
 *   cross-origin — Chrome fires load for its own error page, so readiness waits
 *                  for the probe
 */
function makePreview({ isDevServer, probe }) {
  let state = 'loading'
  let note = ''
  let probeOk = false
  let framed = false

  const runProbe = () => {
    try {
      const r = probe()
      if (!isDevServer && r.status >= 500) throw new Error(`backend returned ${r.status}`)
      probeOk = true
      if (framed && state !== 'unreachable') state = 'ready'
    } catch (e) {
      // Never overrule a same-origin frame that already rendered.
      if (framed && !isDevServer) return
      state = 'unreachable'
      note = e.message
    }
  }

  return {
    get state() { return state },
    get note() { return note },
    probeNow() { runProbe() },
    load() {
      framed = true
      // Same-origin: the frame rendering IS the answer, and it overrides an
      // earlier probe failure — a preview that visibly works must never stay
      // behind an error card. Dev server: a frame proves nothing on its own.
      if (!isDevServer) { state = 'ready'; return }
      if (state === 'unreachable') return
      if (probeOk) state = 'ready'
    },
    tick(ms) {
      if (ms >= 12000 && state === 'loading') { state = 'unreachable'; note = note || 'timed out' }
    },
  }
}

const ok = () => ({ status: 200 })
const refused = () => { throw new Error('Failed to fetch') }
const notFound = () => ({ status: 404 })
const crashed = () => ({ status: 502 })

const checks = []
const check = (name, got, want) => checks.push({ name, ok: got === want, got, want })

// --- the reported bug: blank with no explanation --------------------------
let p = makePreview({ isDevServer: false, probe: ok })
check('starts in loading, not blank-with-no-state', p.state, 'loading')
p.load()
check('same-origin frame loading is enough to be ready', p.state, 'ready')

// --- REGRESSION: a failed probe must not mask a working preview -----------
// This is the bug that made the panel look permanently broken: the probe threw,
// the overlay latched, and the perfectly good iframe underneath stayed hidden.
p = makePreview({ isDevServer: false, probe: refused })
p.load()                      // the frame rendered fine
p.probeNow()                  // ...and only then did the probe fail
check('a same-origin probe failure AFTER load does not mask the frame', p.state, 'ready')

p = makePreview({ isDevServer: false, probe: refused })
p.probeNow()                  // probe fails first
check('a same-origin probe failure before load reports unreachable', p.state, 'unreachable')
p.load()
check('  ...and a later load recovers it', p.state, 'ready')

// --- dev server not started ----------------------------------------------
p = makePreview({ isDevServer: true, probe: refused })
p.probeNow()
check('an unreachable dev server is reported, not left blank', p.state, 'unreachable')
check('  ...and carries the reason', p.note, 'Failed to fetch')
p.load()
check('Chrome loading its OWN error page does not flip it to ready', p.state, 'unreachable')

// --- dev server up: needs both signals -----------------------------------
p = makePreview({ isDevServer: true, probe: ok })
p.load()
check('a dev-server frame alone is not yet proof', p.state, 'loading')
p.probeNow()
check('  ...ready once the probe confirms it', p.state, 'ready')

p = makePreview({ isDevServer: true, probe: ok })
p.probeNow()
check('probe first, frame second also reaches ready', p.state, 'loading')
p.load()
check('  ...on load', p.state, 'ready')

// --- do not hide the backend's diagnostic page ---------------------------
p = makePreview({ isDevServer: false, probe: notFound })
p.probeNow()
check('a same-origin 404 is not an error (diagnostic page must show)', p.state, 'loading')
p.load()
check('  ...and reaches ready when that page renders', p.state, 'ready')

// --- a genuinely broken backend IS an error -----------------------------
p = makePreview({ isDevServer: false, probe: crashed })
p.probeNow()
check('a 5xx from our own backend is an error state', p.state, 'unreachable')
check('  ...naming the status', p.note, 'backend returned 502')

// --- the silent-hang backstop -------------------------------------------
p = makePreview({ isDevServer: true, probe: ok })
p.tick(11999)
check('still loading just before the timeout', p.state, 'loading')
p.tick(12000)
check('a frame that never loads times out instead of hanging blank', p.state, 'unreachable')
check('  ...saying so', p.note, 'timed out')

p = makePreview({ isDevServer: false, probe: ok })
p.load()
p.tick(20000)
check('the timeout cannot un-ready a loaded preview', p.state, 'ready')

let failed = 0
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!c.ok) { failed++; console.log(`        got ${c.got!== undefined ? JSON.stringify(c.got) : c.got}, want ${JSON.stringify(c.want)}`) }
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PREVIEW-STATE CHECKS PASSED')
process.exit(failed ? 1 : 0)
