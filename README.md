# Poke & Prose

*(internal app id: `poke-and-prose`)*

Visually select elements in your live app preview and turn them into scoped,
source-mapped edit requests for the KiroClaw agent — like Figma comments, for code.

For **designers and front-end engineers** iterating on UI: right-click an element
in the preview, type "make this sticky on scroll", and the agent edits the exact
source file/line — no describing "the button in the top nav, second from the right".

---

## How it maps onto KiroClaw

The original spec assumed a generic coding-tool add-on host (preview panel +
keybindings + a "write to chat" command). KiroClaw's App Kit is a Python backend +
a dashboard React page + skills. This app adapts the design accordingly:

| Spec concept              | KiroClaw implementation                                        |
|---------------------------|----------------------------------------------------------------|
| Preview panel             | Dashboard app page hosting an `<iframe>` at your dev server     |
| Selection overlay         | `inject/select-to-edit.js` — a `<script>` you add in dev builds |
| Panel ↔ host bridge       | `window.postMessage` from the iframe → dashboard page → backend |
| Source mapping            | `plugins/vite-plugin-kiro-source.js` → `data-kiro-source`       |
| Delivery into the agent   | Backend queues a `visual_edit_request`; the `visual-edit` skill drives the agent. The dashboard page also offers "Send latest to agent" via the SDK `useChatLauncher().openChat({ message })`. |

---

## Structure

```
poke-and-prose/
├── app.json                       ← manifest (UI page + backend + skill + perms)
├── backend/server.py              ← receives/queues visual_edit_request payloads
├── skills/visual-edit/SKILL.md    ← teaches the agent to read + apply requests
├── inject/select-to-edit.js       ← drop-in selection overlay for your dev server
├── plugins/
│   ├── babel-plugin-kiro-source.js
│   └── vite-plugin-kiro-source.js ← injects data-kiro-source in dev
└── ui/index.mjs                   ← dashboard page (federated ESM, no build step)
```

## Install & enable

The UI is a hand-written federated ES module (like KiroClaw's shipping `demo-app`) —
it resolves React, `@kiroclaw/app-sdk`, and `lucide-react` from the host import map
at runtime, so **there is no npm build step**.

**From GitHub (recommended for sharing):**

```bash
git clone https://github.com/michellemxm/poke-and-prose.git
kiroclaw app install ./poke-and-prose
kiroclaw app enable poke-and-prose
```

Then restart the KiroClaw gateway (quit + reopen the app) so the backend spawns.

**Or via the App Store (registry):** add this repo to your KiroClaw config under
`registries` — `{ "name": "poke-and-prose", "repo": "https://github.com/michellemxm/poke-and-prose.git", "branch": "main" }` —
and install from the Apps page.

> ⚠️ **Trust note:** enabling any KiroClaw app runs its code in-process with full
> gateway privileges. Review `app.json` and `backend/server.py` before enabling.

> ⚠️ Enabling any KiroClaw app runs its code in-process with full gateway
> privileges (see App Platform Trust Model). Only enable apps you trust.

## Wiring the selection script (in your app being previewed)

**High-confidence source mapping (recommended)** — add the Vite plugin to your app:

```js
// vite.config.ts (of the app you're designing)
import kiroSource from '/ABS/PATH/apps/poke-and-prose/plugins/vite-plugin-kiro-source.js'
export default defineConfig({ plugins: [react(), kiroSource()] })
// devDeps needed: @babel/core @babel/preset-typescript
```

**Load the overlay in dev only** — e.g. in `index.html`:

```html
<script type="module" src="/@fs/ABS/PATH/apps/poke-and-prose/inject/select-to-edit.js"></script>
```

(Or copy `select-to-edit.js` into your app's `public/` and reference it. Never ship
it to production.)

Without the Vite plugin the overlay still works — it falls back to React Fiber
`_debugSource` (medium confidence) or an HTML-snippet-only payload (low confidence),
and the agent verifies before editing.

## Use it

1. In the dashboard **Select to Edit** page, enter your dev server URL and click **Load**.
2. In the preview, click **◎ Select to Edit** (or press **Alt+S**).
3. **Right-click** an element → a comment box appears. Type the change, press **Enter**.
4. The request is queued; click **Send latest to agent →** (or ask in chat: "apply the
   pending select-to-edit request"). The agent edits the source; your dev server
   hot-reloads.

## Publishing to the KiroClaw App Store

The app is a self-contained directory with a valid `app.json`. To distribute:
push this directory to a git repo and share the install command, or submit it to
the org's app registry. No build artifacts to ship — `ui/index.mjs` is loaded as-is.

## Roadmap

- **MVP (this):** right-click single-select, floating comment, Vite source mapping,
  queue-based delivery + skill, and "Send latest to agent" via `useChatLauncher`.
- **V1:** marquee multi-select; low-confidence HTML-snippet fallback surfaced with a
  confidence badge; auto-forward each capture straight into chat (skip the manual button).
- **V2:** Fiber-tree framework-agnostic mapping; selection history / undo; nested-iframe
  selection.
