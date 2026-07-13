# Poke & Prose

*(internal app id: `poke-and-prose`)*

**Point, describe, and watch the code catch up.**

Visually select elements in a live preview of your web app and turn them into
scoped, source-mapped edit requests for your coding agent — like Figma
comments, for code.

For **designers and front-end engineers** iterating on UI: switch the preview to
Edit mode, right-click an element, type "make this sticky on scroll", and the
agent edits the exact source file — no describing "the button in the top nav,
second from the right".

---

## Features (v0.4.0)

- **Multi-app workspace** — register any number of local web app folders via the
  native macOS folder picker (`+ load new app`). All of them are served
  simultaneously by the app's backend at per-project URLs, so **switching apps in
  the dropdown is instant** — no dev server to run, no reconnecting.
- **Connect / Connected** — filled button connects the selected app; the outlined
  "Connected" state disconnects on click (the app stays registered). Hovering an
  app in the dropdown reveals an **X** to remove it from the list (folder on disk
  untouched).
- **Visual edit requests** — in Edit mode, right-click an element in the preview,
  type a comment, and it lands in the left rail as a numbered request card with
  element info, status chip (`new` → `in progress` → `done`), and relative time.
  Send it to the agent with one click — the payload carries `projectRoot` and
  `sourceFile`, so the agent edits the right file without searching.
- **History** — handled requests collect in a bottom-fixed History section that
  expands upward.
- **Preview controls** — bottom action bar with a per-app **Dimensions** preset
  (Desktop / Tablet 768px / Mobile 390px) and the **Preview | Edit** mode switcher.
- **Layout** — resizable two-panel layout (drag the gap; 360–800px left rail,
  persisted), each panel in a bordered 16px-radius container.
- **Fully themed** — every color derives from the host's theme tokens
  (`--accent`, `--accent-fg`, `--panel`, `--border`, …), including the selection
  overlay inside the preview. Switch the host theme and Poke & Prose follows.
- **Self-update** — the sync button in the header pulls the latest version of
  this app from GitHub; the GitHub button opens this repo.

## Install & enable

The UI is a hand-written federated ES module — it resolves React,
`@kiroclaw/app-sdk`, and `lucide-react` from the host import map at runtime, so
**there is no npm build step**.

**From GitHub (recommended for sharing):**

```bash
git clone https://github.com/michellemxm/poke-and-prose.git
kiroclaw app install ./poke-and-prose
kiroclaw app enable poke-and-prose
```

Then restart the host gateway (quit + reopen the app) so the backend spawns.

**Or via the App Store (registry):** add this repo to your host config under
`registries` — `{ "name": "poke-and-prose", "repo": "https://github.com/michellemxm/poke-and-prose.git", "branch": "main" }` —
and install from the Apps page.

> ⚠️ **Trust note:** enabling any app runs its code in-process with full
> gateway privileges (see the host's App Platform Trust Model). Review `app.json`
> and `backend/server.py` before enabling. Only enable apps you trust.

## Use it

1. Open **Poke & Prose** in the dashboard sidebar.
2. Click the app dropdown → **+ load new app** → pick your web app's folder in
   the native chooser (or type a path). It previews immediately.
3. Flip the bottom-right switcher to **Edit**, then **right-click** any element
   in the preview → type the change → **Enter**.
4. The request appears in the left rail. Click its **send** icon — the agent
   opens in chat with the full source-mapped payload, makes the edit, and the
   preview reflects it on reload.
5. Switch between registered apps in the dropdown any time — every app stays
   live, and Dimensions preferences are remembered per app.

Works out of the box for static HTML/CSS/JS folders. For Vite/React projects you
can also point it at a running dev server URL, and optionally add the bundled
source-mapping plugin for exact `file:line:col` targeting (see below).

## How it works

| Concern                | Implementation                                                        |
|------------------------|-----------------------------------------------------------------------|
| Preview                | Backend serves each registered folder same-origin at `/proxy/<id>/` (the dashboard CSP is `frame-src 'self'`, so same-origin serving is required) |
| Selection overlay      | `inject/select-to-edit.js`, auto-injected into served HTML — no manual wiring |
| Panel ↔ overlay bridge | `window.postMessage` both ways (selections up; mode + theme colors down) |
| Source mapping         | `projectRoot` + `sourceFile` stamped per request from the serving path; optional `plugins/vite-plugin-kiro-source.js` adds `data-kiro-source="file:line:col"` for framework projects |
| Delivery into agent    | Request queued as JSON in the app's data dir; `useChatLauncher().openChat()` hands it to chat; the bundled `visual-edit` skill teaches the agent the payload format |

## Structure

```
poke-and-prose/
├── app.json                       ← manifest (UI page + backend + skill + perms)
├── backend/server.py              ← project registry, multi-root static serving,
│                                    request queue, folder picker, self-update
├── skills/visual-edit/SKILL.md    ← teaches the agent to read + apply requests
├── inject/select-to-edit.js       ← selection overlay (auto-injected into previews)
├── plugins/
│   ├── babel-plugin-kiro-source.js
│   └── vite-plugin-kiro-source.js ← optional dev-time source mapping for Vite apps
└── ui/index.mjs                   ← dashboard page (federated ESM, no build step)
```

## Optional: exact source mapping for Vite/React apps

```js
// vite.config.ts (of the app you're designing)
import kiroSource from '/ABS/PATH/poke-and-prose/plugins/vite-plugin-kiro-source.js'
export default defineConfig({ plugins: [react(), kiroSource()] })
// devDeps needed: @babel/core @babel/preset-typescript
```

With the plugin, every element carries `data-kiro-source="file:line:col"` and the
agent gets high-confidence targets. Without it, requests fall back to React Fiber
`_debugSource` (medium) or HTML-snippet matching within the known `sourceFile`
(low), and the agent verifies before editing.

## Roadmap

- Marquee multi-select (select several elements in one request)
- Confidence badge on request cards
- Design Resource tab (currently a placeholder)
- Selection history / undo of the last visual edit
