/**
 * The panel's project-identity match: does a comment belong to the previewed
 * project? Mirrors `belongsToPreview` in ui/index.mjs.
 *
 * The id path is what makes dev-server previews work; the previewUrl path is the
 * fallback that keeps comments captured before the id existed (and anything the
 * migration script rewrote) attached to their project.
 */
function belongsToPreview(c, previewId) {
  if (!previewId) return false
  if (c?.projectId) return c.projectId === previewId
  return (c?.previewUrl || '').includes(`/proxy/${previewId}/`)
}

const PROXY = (id, file) => `http://x/apps/poke-and-prose/api/proxy/${id}/${file}`
const checks = []
function check(name, got, want) {
  checks.push({ name, ok: got === want, got, want })
}

// --- the case this change exists for -------------------------------------
check('dev-server comment matches its own project by id',
  belongsToPreview({ projectId: 'p1', previewUrl: 'http://localhost:5173/pricing' }, 'p1'), true)
check('dev-server comment does NOT match a different project',
  belongsToPreview({ projectId: 'p2', previewUrl: 'http://localhost:5173/pricing' }, 'p1'), false)
check('two dev servers on the same port stay distinct (URL alone cannot tell them apart)',
  belongsToPreview({ projectId: 'p2', previewUrl: 'http://localhost:5173/' }, 'p1'), false)

// --- proxied projects keep working --------------------------------------
check('proxied comment matches by id',
  belongsToPreview({ projectId: 'p1', previewUrl: PROXY('p1', 'index.html') }, 'p1'), true)
check('id wins over a stale URL',
  belongsToPreview({ projectId: 'p1', previewUrl: PROXY('old', 'index.html') }, 'p1'), true)

// --- the fallback, for pre-change and migrated comments -----------------
check('no id: falls back to the proxy URL',
  belongsToPreview({ previewUrl: PROXY('p1', 'about.html') }, 'p1'), true)
check('no id, different project in the URL',
  belongsToPreview({ previewUrl: PROXY('p9', 'about.html') }, 'p1'), false)
check('no id and a dev-server URL is unattributable (honest false, not a wrong match)',
  belongsToPreview({ previewUrl: 'http://localhost:5173/pricing' }, 'p1'), false)
check('empty-string id does not short-circuit the fallback',
  belongsToPreview({ projectId: '', previewUrl: PROXY('p1', 'x.html') }, 'p1'), true)

// --- guards --------------------------------------------------------------
check('no preview selected matches nothing',
  belongsToPreview({ projectId: 'p1', previewUrl: PROXY('p1', 'i.html') }, ''), false)
check('a comment with neither field matches nothing',
  belongsToPreview({}, 'p1'), false)
// A bare id must not match by substring — 'p1' appearing inside 'p10' would
// otherwise leak one project's pins into another's preview.
check('id comparison is exact, not a substring',
  belongsToPreview({ projectId: 'p10' }, 'p1'), false)

let failed = 0
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!c.ok) { failed++; console.log(`        got ${c.got}, want ${c.want}`) }
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PROJECT-IDENTITY CHECKS PASSED')
process.exit(failed ? 1 : 0)
