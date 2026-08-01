// Panel-side per-app scoping and the boot loading state.
//
// The backend serves EVERY app's requests in one fetch (so switching apps is
// instant, no refetch). Scoping is therefore the panel's job, and getting it
// wrong is invisible until you own two apps: the list silently shows the other
// app's backlog.
//
// The boot flag exists because `projects` starts empty, so the panel painted
// "No web apps loaded yet." during the very first fetch — on reopen or reconnect
// that reads as "my apps are gone".
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../ui/index.mjs', import.meta.url), 'utf8')
const checks = []
const check = (name, got, want) => checks.push({ name, ok: got === want, got, want })

// ---- the scoping predicate, lifted verbatim in behaviour --------------
function belongsToPreview(c, previewId) {
  if (!previewId) return false
  if (c?.projectId) return c.projectId === previewId
  return (c?.previewUrl || '').includes(`/proxy/${previewId}/`)
}
const scope = (rows, id) => rows.filter((r) => belongsToPreview(r, id))

const rows = [
  { id: 'r1', number: 1, projectId: 'A' },
  { id: 'r2', number: 2, projectId: 'B' },
  { id: 'r3', number: 2, projectId: 'A' },
  { id: 'r4', number: 9, previewUrl: 'http://h/api/proxy/B/index.html' }, // legacy
]
check('app A sees only its own requests',
  scope(rows, 'A').map((r) => r.id).join(','), 'r1,r3')
check('app B sees only its own', scope(rows, 'B').map((r) => r.id).join(','), 'r2,r4')
check('  ...including a legacy request matched by proxy url',
  scope(rows, 'B').some((r) => r.id === 'r4'), true)
check('nothing is shown when no app is connected', scope(rows, '').length, 0)
// The same number can legitimately exist twice across apps now that numbering is
// per project — the two must never collapse into one row.
check('a number shared across apps stays two distinct requests',
  rows.filter((r) => r.number === 2).length, 2)
check('  ...and each shows under only one app',
  scope(rows, 'A').filter((r) => r.number === 2).length
  + scope(rows, 'B').filter((r) => r.number === 2).length, 2)

// ---- the wiring is actually used in the render ------------------------
check('the scoped pending list is derived', /const myPending = useMemo\(/.test(src), true)
check('the scoped history list is derived', /const myHistory = useMemo\(/.test(src), true)
check('useMemo is destructured from React',
  /const \{[^}]*useMemo[^}]*\} = React/.test(src), true)
// Rendering the raw lists is the actual bug this guards; the only permitted uses
// of `pending`/`history` are deriving the scoped lists and the cross-app cid index.
const rendersRaw = /withFollowUpLabels\((pending|history)\)/.test(src)
check('the render never uses the unscoped lists', rendersRaw, false)
check('the history COUNT is scoped too',
  /\$\{myHistory\.length\}/.test(src), true)
// The overlay wants COMMENTS (each with a locator); feeding it requests made
// reconcile() drop every pin, because a request has no locator and its id never
// enters the overlay's `seen` map.
check('pin items are derived from the scoped requests',
  /const pinItems = useMemo\(/.test(src) && /for \(const req of myPending\)/.test(src), true)
check('every overlay push sends pinItems',
  (src.match(/type: 'requests', items: pinItems/g) || []).length, 2)
check('  ...and nothing pushes raw requests as pins',
  /items: myPending|const items = myPending/.test(src), false)
// The cid index is deliberately global: a follow-up must resolve its origin
// comment even after that request was archived.
check('the cid index still spans pending AND history',
  /for \(const req of \[\.\.\.pending, \.\.\.history\]\)/.test(src), true)

// ---- boot loading state ----------------------------------------------
check('a booting flag exists, defaulting to true',
  /const \[booting, setBooting\] = useState\(true\)/.test(src), true)
check('it clears when the first refresh settles',
  /setBooting\(false\)/.test(src), true)
// It must clear on FAILURE too, or an unreachable backend spins forever.
const refresh = src.slice(src.indexOf('const refresh = useCallback'),
  src.indexOf('useEffect(() => {\n    refresh()'))
const lastCatch = refresh.lastIndexOf('catch')
check('  ...outside every try/catch, so a failed fetch still settles it',
  lastCatch < refresh.indexOf('setBooting(false)'), true)
// Matched by the copy plus a nearby `booting` guard rather than one big regex:
// the markup nests h(RefreshCw, {...}) calls, so a bracket-class pattern cannot
// span it and would fail on correct code.
const guarded = (needle) => {
  const i = src.indexOf(needle)
  return i > 0 && src.lastIndexOf('booting', i) > i - 400
}
check('the left panel shows a loading row while booting',
  guarded('Loading your apps'), true)
check('the preview pane does not claim "no app selected" while booting',
  guarded('Looking for your connected apps'), true)
check('the dropdown does not claim "none" while booting',
  /booting && projects\.length === 0/.test(src), true)
check('  ...but still says so once settled',
  /: projects\.length === 0\s*\n\s*\? h\('div'[^)]*No web apps loaded yet/.test(src), true)

// Copy check: the empty state must distinguish "nothing connected" from
// "connected, no requests yet" — they need different next actions.
check('the empty state distinguishes not-connected from no-requests',
  /!previewId\s*\n?\s*\? 'No web app connected/.test(src), true)

let failed = 0
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!c.ok) { failed++; console.log(`        got ${JSON.stringify(c.got)}, want ${JSON.stringify(c.want)}`) }
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PER-APP PANEL CHECKS PASSED')
process.exit(failed ? 1 : 0)

// ---- regressions found by investigation, each with a distinct failure mode ----

// A long-lived listener cannot close over previewId: it captured '' forever, so
// every comment was stamped projectId:'' — invisible on dev-server previews,
// where no URL fallback can recover it.
check('captures read previewId through a ref, not a closure',
  /const previewIdRef = useRef/.test(src)
  && /projectId: previewIdRef\.current/.test(src), true)
check('  ...and no capture still uses the closed-over value',
  /projectId: previewId\b/.test(src), false)

// POST /api/chat without ?ws=1 answers with an SSE stream; JSON.parse threw and
// the catch "recovered" by opening a NEW chat, so one request made two sessions.
check('chat dispatch asks for the JSON (ws) response',
  /\/api\/chat\?ws=1/.test(src), true)
check('chatApi tolerates a non-JSON body instead of throwing',
  /catch \{ return \{ ok: true, raw: t \} \}/.test(src), true)
// Exactly one openChat remains: the case where no folder is known, so there is
// nothing to key a per-app session on.
check('openChat is no longer a failure fallback',
  (src.match(/openChat\(\{ message: msg \}\)/g) || []).length, 1)
check('a failed dispatch surfaces instead of diverting',
  /Send failed: \$\{err\?\.message \|\| err\}/.test(src), true)

// projectRoot is the field that stayed correct when projectId did not.
check('scoping falls back to projectRoot before the proxy URL',
  src.indexOf('c?.projectRoot === root') > 0
  || /return c\.projectRoot === root/.test(src), true)
check('previewProject is declared before the predicate that depends on it',
  src.indexOf('const previewProject =') < src.indexOf('const belongsToPreview ='), true)
