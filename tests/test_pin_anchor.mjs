// The pin anchor chain: a pin must OUTLIVE its element.
//
// The old behaviour deleted any pin whose locator stopped resolving, which is
// exactly backwards for the two comments that matter most:
//   "delete this"   → the agent removes the node and the bubble reporting the work
//                     disappears with it
//   "add a X here"  → there is no element yet, so there is nothing to anchor to
//
// Resolution is now a chain that never fails:
//   exact  [data-kiro-cid] stamped by the agent on the element it created
//   locator the selector captured at comment time
//   parent  the element's former parent (it was deleted)
//   point   where the user clicked, in document space
//   page    bottom-left, when even the point is unusable
//
// `resolveAnchor` is re-implemented here against a tiny DOM stub rather than
// loading the overlay (which needs a real window at import time); the ORDER is
// asserted against the shipped source so the two cannot drift apart.
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../inject/select-to-edit.js', import.meta.url), 'utf8')
const checks = []
const check = (name, got, want) => checks.push({ name, ok: got === want, got, want })

// ---- a DOM stub: selector -> element ----------------------------------
function makeDoc(map) {
  return {
    querySelector(sel) {
      const el = map[sel]
      return el ? { ...el, isConnected: true, sel } : null
    },
  }
}
const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&')

// Mirrors the shipped chain, including the try/catch around every query: a
// selector captured from one page can be syntactically invalid on another, and a
// throw there would kill the whole reconcile pass and every pin with it.
function resolveAnchor(it, existing, doc) {
  let el = null
  const q = (sel) => { try { return doc.querySelector(sel) } catch { return null } }
  el = q(`[data-kiro-cid="${cssEscape(it.id)}"]`)
  if (el) return { el, kind: 'exact' }
  if (existing && existing.el && existing.el.isConnected && existing.kind === 'locator') {
    return { el: existing.el, kind: 'locator' }
  }
  if (it.locator) {
    el = q(it.locator)
    if (el) return { el, kind: 'locator' }
  }
  if (it.parentLocator) {
    el = q(it.parentLocator)
    if (el) return { el, kind: 'parent' }
  }
  if (it.point && typeof it.point.x === 'number') return { el: null, kind: 'point' }
  return { el: null, kind: 'page' }
}

const item = {
  id: 'c-8f2a91',
  locator: 'main > div:nth-of-type(3)',
  parentLocator: 'main',
  point: { x: 240, y: 900 },
}

// ---- the ordinary case ------------------------------------------------
check('an element that resolves anchors to itself',
  resolveAnchor(item, null, makeDoc({ 'main > div:nth-of-type(3)': {}, main: {} })).kind, 'locator')

// ---- "delete this" ---------------------------------------------------
const deleted = makeDoc({ main: {} })       // the element is gone, parent remains
check('a DELETED element falls back to its parent',
  resolveAnchor(item, null, deleted).kind, 'parent')
check('  ...and the pin is NOT removed', resolveAnchor(item, null, deleted).el !== null, true)
// The whole subtree can go, not just the node.
check('parent gone too → the click point',
  resolveAnchor(item, null, makeDoc({})).kind, 'point')
check('  ...and with no point recorded, the page corner',
  resolveAnchor({ ...item, point: null }, null, makeDoc({})).kind, 'page')

// ---- "add something new" (re-homing) ---------------------------------
// Before the agent has built anything, nothing resolves but the point.
const nothingYet = makeDoc({})
check('a comment for a NEW element starts at the click point',
  resolveAnchor({ id: 'c-new', point: { x: 10, y: 20 } }, null, nothingYet).kind, 'point')
// Once the agent stamps the element it created, the pin re-homes onto it.
const stamped = makeDoc({ '[data-kiro-cid="c-new"]': { tag: 'button' } })
check('  ...then re-homes onto the stamped element',
  resolveAnchor({ id: 'c-new', point: { x: 10, y: 20 } }, null, stamped).kind, 'exact')

// The stamp must beat a cached element AND a still-matching locator — otherwise a
// pin would stay glued to the neighbour the user originally right-clicked.
const both = makeDoc({
  '[data-kiro-cid="c-8f2a91"]': { tag: 'button' },
  'main > div:nth-of-type(3)': { tag: 'div' },
  main: {},
})
check('the stamp wins over a live locator', resolveAnchor(item, null, both).kind, 'exact')
check('  ...and over a cached live element',
  resolveAnchor(item, { el: { isConnected: true }, kind: 'locator' }, both).kind, 'exact')
// A cached element is still preferred over re-querying when it is the ONLY answer,
// so a pin does not jump between nodes a loose selector both matches.
check('a cached live element is reused when nothing is stamped',
  resolveAnchor(item, { el: { isConnected: true, sel: 'cached' }, kind: 'locator' },
    makeDoc({ 'main > div:nth-of-type(3)': {} })).el.sel, 'cached')
// But a cached PARENT anchor must be re-checked, or a pin that fell back to the
// parent could never return to its element once the agent recreated it.
check('a cached PARENT anchor is re-resolved, not frozen',
  resolveAnchor(item, { el: { isConnected: true }, kind: 'parent' },
    makeDoc({ 'main > div:nth-of-type(3)': { tag: 'div' } })).kind, 'locator')

// ---- a malformed selector must not throw -----------------------------
const throwing = { querySelector() { throw new Error('bad selector') } }
let threw = false
try { resolveAnchor(item, null, throwing) } catch { threw = true }
check('a selector that throws is caught, not propagated', threw, false)
check('  ...and every query in the shipped chain is guarded',
  (fnGuards(src).every(Boolean)), true)

// ---- the shipped source must match this order ------------------------
const fn = src.slice(src.indexOf('function resolveAnchor'), src.indexOf('function cssEscape'))
function fnGuards(s) {
  const body = s.slice(s.indexOf('function resolveAnchor'), s.indexOf('function cssEscape'))
  // one try{...}catch per querySelector call
  const queries = (body.match(/querySelector/g) || []).length
  const guards = (body.match(/try \{/g) || []).length
  return [queries > 0, guards >= queries]
}
const order = ['data-kiro-cid', 'existing.kind === "locator"', 'it.locator', 'it.parentLocator', 'it.point']
let last = -1, ordered = true
for (const needle of order) {
  const i = fn.indexOf(needle)
  if (i < 0 || i < last) ordered = false
  last = i
}
check('the shipped chain tries anchors in the asserted order', ordered, true)
check('the shipped chain never removes a pin',
  /removePin/.test(fn), false)
// The old line that caused both bugs must be gone.
check('reconcile no longer deletes an unresolvable pin',
  /if \(!el\) \{ if \(existing\) removePin/.test(src), false)
// positionPin used to hide an element-less pin; that was the same bug downstream.
check('an element-less pin is positioned, not hidden',
  /if \(!p\.el \|\| !p\.el\.isConnected\) return positionLoosePin\(p\)/.test(src), true)
check('a zero-size element also falls back instead of hiding',
  /r\.width === 0 && r\.height === 0\) return positionLoosePin/.test(src), true)
check('the page anchor sits at the BOTTOM-left',
  /top = window\.innerHeight - PAGE_PIN_INSET - 24/.test(src), true)
check('a loose pin is clamped into view',
  /Math\.min\(Math\.max\(left, 4\), maxL\)/.test(src), true)
check('a loose pin is visually distinguishable (dashed)',
  /borderStyle = loose \? "dashed"/.test(src), true)

// A loose pin still has to be clickable: its thread popover anchors to the DOT,
// because there is no element to anchor to.
check('the thread popover falls back to the pin dot',
  /positionFloat\(popover, p\.el \|\| p\.dot\)/.test(src), true)
check('  ...and so does reposition-on-scroll',
  /positionFloat\(popover, pins\[popoverId\]\.el \|\| pins\[popoverId\]\.dot\)/.test(src), true)

// ---- capture records both fallbacks ----------------------------------
check('capture records the former parent', /parentLocator: el\.parentElement/.test(src), true)
check('capture records a document-space point',
  /point: \{ x: Math\.round\(r\.x \+ window\.scrollX\)/.test(src), true)

let failed = 0
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!c.ok) { failed++; console.log(`        got ${JSON.stringify(c.got)}, want ${JSON.stringify(c.want)}`) }
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PIN-ANCHOR CHECKS PASSED')
process.exit(failed ? 1 : 0)
