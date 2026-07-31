/**
 * Behavioural check for the app-selector dropdown: outside-click dismissal,
 * Escape, and the downward entrance. Replicates the real handler wiring against
 * a jsdom-free minimal DOM stub so it runs with plain `node`.
 */
let listeners = { mousedown: [], keydown: [] }
const doc = {
  addEventListener: (t, fn, capture) => listeners[t].push({ fn, capture }),
  removeEventListener: (t, fn) => { listeners[t] = listeners[t].filter((l) => l.fn !== fn) },
}

function el(name, children = []) {
  const node = { name, children }
  node.contains = (t) => t === node || children.some((c) => c.contains(t))
  return node
}

// --- the row: trigger and Connect are siblings; panel is separate ---
const projectRow = el('project-row')
const trigger = el('trigger')
const connectBtn = el('connect')
const panelInput = el('path-input')
const panel = el('panel', [panelInput])
const elsewhere = el('elsewhere')

// --- the handler under test, mirroring ui/index.mjs ---
let ddOpen = false
let adding = false
let ddIn = false
let raf = null

function openMenu() { ddOpen = true; wire() }
function wire() {
  teardown()
  if (!ddOpen) { ddIn = false; return }
  raf = 1
  const onDown = (e) => {
    const inTrigger = trigger.contains(e.target)
    const inPanel = panel.contains(e.target)
    if (!inTrigger && !inPanel) { ddOpen = false; adding = false }
  }
  const onKey = (e) => { if (e.key === 'Escape') { ddOpen = false; adding = false } }
  doc.addEventListener('mousedown', onDown, true)
  doc.addEventListener('keydown', onKey)
}
function teardown() { listeners = { mousedown: [], keydown: [] } }
function fireDown(target) { listeners.mousedown.forEach((l) => l.fn({ target })) }
function fireKey(key) { listeners.keydown.forEach((l) => l.fn({ key })) }
function commitFrame() { if (raf) { ddIn = true; raf = null } }

const checks = []
function check(name, fn) {
  ddOpen = false; adding = false; ddIn = false; teardown()
  let err = null
  try { fn() } catch (e) { err = e }
  checks.push({ name, ok: !err, err })
}

check('click outside dismisses', () => {
  openMenu(); fireDown(elsewhere)
  if (ddOpen) throw new Error('menu stayed open')
})

check('click the trigger does NOT outside-dismiss (its onClick toggles)', () => {
  openMenu(); fireDown(trigger)
  if (!ddOpen) throw new Error('outside handler wrongly closed on the trigger')
})

check('click inside the panel keeps it open', () => {
  openMenu(); fireDown(panelInput)
  if (!ddOpen) throw new Error('closed on an in-panel click')
})

check('click Connect (sibling in the same row) dismisses', () => {
  openMenu(); fireDown(connectBtn)
  if (ddOpen) throw new Error('sibling click did not dismiss — ref scoped too widely')
})

check('Escape dismisses', () => {
  openMenu(); fireKey('Escape')
  if (ddOpen) throw new Error('Escape did not dismiss')
})

check('other keys do not dismiss', () => {
  openMenu(); fireKey('a')
  if (!ddOpen) throw new Error('a stray keypress closed the menu')
})

check('dismissal also cancels the add-a-path form', () => {
  openMenu(); adding = true; fireDown(elsewhere)
  if (adding) throw new Error('adding state survived dismissal')
})

check('entrance starts hidden, then commits on the next frame', () => {
  openMenu()
  if (ddIn) throw new Error('entrance began already-visible (no transition)')
  commitFrame()
  if (!ddIn) throw new Error('entrance never committed')
})

check('listeners are removed when the menu closes', () => {
  openMenu(); fireDown(elsewhere); wire()
  const n = listeners.mousedown.length + listeners.keydown.length
  if (n !== 0) throw new Error(`${n} listener(s) leaked after close`)
})

let failed = 0
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!c.ok) { failed++; console.log(`        ${c.err.message}`) }
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL DROPDOWN CHECKS PASSED')
process.exit(failed ? 1 : 0)
