# Design Tweak

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

## Features (v0.8.0)

- **Static sites and framework apps** — a folder that can be served from disk is
  previewed immediately; one whose entry point is TypeScript/JSX is recognised as
  a web app, tagged `dev`, and offered a **Start dev server** button. The app runs
  the project's own dev script, finds the port it chose, and frames it directly so
  hot reload keeps working. An already-running server is adopted, not duplicated.
- **Multi-app workspace** — register any number of local web app folders via the
  native macOS folder picker (`+ load new app`). All of them are served
  simultaneously by the app's backend at per-project URLs, so **switching apps in
  the dropdown is instant** — no dev server to run, no reconnecting.
- **Connect / Connected** — filled button connects the selected app; the outlined
  "Connected" state disconnects on click (the app stays registered). Hovering an
  app in the dropdown reveals an **X** to remove it from the list (folder on disk
  untouched).
- **Batched edit requests** — in Edit mode, right-click an element and type a
  comment. It joins the current **request** as a numbered sub-item (`3.1`, `3.2`,
  …) instead of firing immediately. Keep commenting, then **send the whole batch
  as one request**. Each comment carries `projectRoot` and `sourceFile`, so the
  agent edits the right file without searching — and a batch may span several
  pages of the same app.
- **Per-comment progress** — every comment has its own status dot
  (`new` → `in progress` → `done`) and its own thread bubble, both in the left
  panel and on its in-preview pin. The request header rolls them up ("1 of 3
  done"). A request's status is *derived* from its comments, never stored.
- **Seal-on-send** — sending closes a request for good. The next comment opens a
  fresh request even while the previous batch is still being worked, so a
  late thought is never appended to something the agent already has.
- **Linked follow-ups** — replying on a comment's pin creates a new comment in
  the *current* draft, linked to the original via `followUpTo` and shown as
  `↩ follow-up to 3.1`. Finished requests are never mutated.
- **Nested left panel** — requests are collapsible groups with their comments
  indented beneath a connector line, matching the host's Sessions folder view.
- **History** — archived requests collect in a bottom-fixed History section that
  expands upward, with their comments intact.
- **Preview controls** — bottom action bar with a per-app **Dimensions** preset
  (Desktop / Tablet 768px / Mobile 390px) and the **Preview | Edit** mode switcher.
  The preview reloads itself each time a comment flips to `done`.
- **Layout** — resizable two-panel layout (drag the gap; 360–800px left panel,
  persisted), each panel in a bordered 16px-radius container.
- **Fully themed** — every color derives from the host's theme tokens
  (`--accent`, `--accent-fg`, `--panel`, `--border`, …), including the selection
  overlay inside the preview. Switch the host theme and Design Tweak follows.
- **Self-update** — the sync button in the header pulls the latest version of
  this app from GitHub; the GitHub button opens this repo.

## Install & enable

The UI is a hand-written federated ES module — it resolves React,
`@kiroclaw/app-sdk`, and `lucide-react` from the host import map at runtime, so
**there is no npm build step**.

**From GitHub (recommended for sharing):**

```bash
git clone https://github.com/michellemxm/kc-app-design-tweak.git
kirocrew app install ./kc-app-design-tweak
kirocrew app enable poke-and-prose
```

Then restart the host gateway (quit + reopen the app) so the backend spawns.

> The install path is the cloned **folder**; `poke-and-prose` is the app's
> internal id (unchanged by the repo rename) and is what `enable` takes.

**Or via the App Store (registry):** add this repo to your host config under
`registries` — `{ "name": "kc-app-design-tweak", "repo": "https://github.com/michellemxm/kc-app-design-tweak.git", "branch": "main" }` —
and install from the Apps page.

> ⚠️ **Trust note:** enabling any app runs its code in-process with full
> gateway privileges (see the host's App Platform Trust Model). Review `app.json`
> and `backend/server.py` before enabling. Only enable apps you trust.

## Use it

1. Open **Design Tweak** in the dashboard sidebar.
2. Click the app dropdown → **+ load new app** → pick your web app's folder in
   the native chooser (or type a path). It previews immediately.
3. Flip the bottom-right switcher to **Edit**, then **right-click** any element
   in the preview → type the change → **Enter**. It lands in the left panel as
   a sub-item of the current request (`3.1`), *not* sent yet.
4. Repeat for as many changes as you want — they collect under the same request.
   Hover a comment to drop it from the draft.
5. Click **Send N comments as Request 3**. The agent opens in chat with the full
   source-mapped batch, works the comments one at a time, and each comment's dot
   turns green as it lands. The preview reloads on every completion.
6. The request is now sealed — your next comment starts Request 4, even if 3 is
   still running. Reply on a pin to file a linked follow-up into the new draft.
7. Switch between registered apps in the dropdown any time — every app stays
   live, and Dimensions preferences are remembered per app.

Works out of the box for static HTML/CSS/JS folders. Projects whose entry point
isn't a top-level `index.html` are handled too — `public/`, `dist/`, `build/`,
`app/`, and other common locations are resolved automatically, and if there's no
entry at all the preview explains what it found instead of failing blank.

**Framework projects (Vite, React Router, Next, …) are detected, not fumbled.** A
folder whose entry script is TypeScript/JSX cannot be served from disk — the
browser can't run it, so it would render an empty page. Design Tweak recognises
that and offers to start the project's own dev server instead:

1. Add the folder as usual. It appears with a `dev` tag.
2. The preview explains that it needs a dev server and offers **Start dev server**.
3. That runs the project's own dev script (`npm run dev`, or the pnpm/yarn/bun
   equivalent from its lockfile), waits for it to listen, and frames it directly —
   so **hot reload keeps working**, which it cannot behind the static proxy.
4. Select-to-edit works unchanged. Add `vite-plugin-kiro-source` to that project
   for exact `file:line:col` targeting (see below).

A dev server you started yourself is adopted rather than duplicated, and stopping
only ever kills a server Design Tweak started. The port is never forced: the dev
tool picks its own and the app finds it by matching the listening port back to the
process, which avoids a per-framework table of port flags.

## How it works

| Concern                | Implementation                                                        |
|------------------------|-----------------------------------------------------------------------|
| Preview                | Backend serves each registered folder same-origin at `/proxy/<id>/` (the dashboard CSP is `frame-src 'self'`, so same-origin serving is required) |
| Entry resolution       | Folder requests try `index.html`, then common nestings (`public/`, `dist/`, `build/`, `app/`, …); `<base href>` points at the served file's own directory |
| Selection overlay      | `inject/select-to-edit.js`, auto-injected into served HTML — no manual wiring |
| Panel ↔ overlay bridge | `window.postMessage` both ways (comments up; mode + theme colors down). A pin's id **is** its comment's `cid` |
| Request model          | One queue file per *request*, holding many comments as sub-items. Comment statuses are authoritative; the request's status is derived from them |
| Source mapping         | `projectRoot` per request + `sourceFile` per comment, stamped from the serving path; optional `plugins/vite-plugin-kiro-source.js` adds `data-kiro-source="file:line:col"` for framework projects |
| Delivery into agent    | Batch queued as JSON in the app's data dir; `useChatLauncher().openChat()` hands it to a per-app chat session; the bundled `visual-edit` skill teaches the agent to work a batch and report per comment via `POST /thread?id=…&cid=…` |

## Structure

```
poke-and-prose/
├── app.json                       ← manifest (UI page + backend + skill + perms)
├── backend/server.py              ← project registry, multi-root static serving,
│                                    batched request queue, folder picker, self-update
├── skills/visual-edit/SKILL.md    ← teaches the agent to work a batch + report per comment
├── inject/select-to-edit.js       ← selection overlay (auto-injected into previews)
├── plugins/
│   ├── babel-plugin-kiro-source.js
│   └── vite-plugin-kiro-source.js ← optional dev-time source mapping for Vite apps
├── tests/                         ← 9 suites, run them all with tests/run-all.sh
│   ├── test_batch_model.py        ← the request/comment model, end to end
│   ├── test_project_classify.py   ← static vs needs-a-dev-server, per lockfile
│   ├── test_toolchain_path.py     ← finding npm when PATH lacks it
│   ├── test_bundler_template.py   ← .tsx entry detection (blank-page guard)
│   ├── test_detect_dev_server.py  ← port → pid → cwd matching
│   ├── audit_host_classes.py      ← Tailwind classes the host bundle lacks
│   └── migrate_to_batch.py        ← one-shot migration for pre-0.7.0 queue files
└── ui/index.mjs                   ← dashboard page (federated ESM, no build step)
```

Run the model checks with `python3 tests/test_batch_model.py` — it boots the real
backend against a throwaway data dir on loopback and touches nothing installed.

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

- Marquee multi-select (select several elements in one comment)
- Confidence badge on comment rows
- Reordering comments within a draft before sending
- Selection history / undo of the last visual edit
- Stale-backend probe (the panel currently can't tell when the running backend
  predates the installed code — a toggle in the Apps page is the fix)
