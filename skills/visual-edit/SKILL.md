---
name: visual-edit
description: Interpret and act on visual_edit_request payloads produced by the Select-to-Edit app. Use when the user references a visual selection, a "select to edit" request, or asks you to apply a pending visual edit.
always: false
---

# Visual Edit — Select-to-Edit request handling

The **Poke & Prose** app lets a designer/front-end engineer visually pick
element(s) in a live preview and attach a natural-language comment. Each capture
is written as a structured `visual_edit_request` JSON file to this app's queue:

```
~/.kiroclaw/apps/poke-and-prose/data/queue/<timestamp>-<id>.json
```

When the user says things like "apply the pending visual edit", "do the select-to-edit
request", or references a selection they just made, do this:

1. **Read the newest file** in the queue directory (highest timestamp). If the user
   named a specific id, use that file. List the dir to find it.
2. **Parse the payload** (schema below). The user's intent is in `comment`.
3. **Resolve the target source.** The payload now includes project context stamped
   by the app backend — prefer it over searching:
   - `projectRoot` — absolute path to the previewed web app's root folder.
   - `sourceFile` — absolute path to the specific file being previewed (e.g. the
     served `index.html`). Open this file first; the selected element is in it.
   Then, within that file, use each element's `source` block by confidence:
   - `confidence: "high"` — `file:line:col` from the build-time plugin. Trust it.
   - `confidence: "medium"` — framework internal (React Fiber). Verify against `htmlSnippet`.
   - `confidence: "low"` — no source map (plain HTML). Locate the node inside `sourceFile`
     by its `htmlSnippet`, `classes`, `id`, or text — you already know the file, so this
     is a search **within one file**, never across the tree.
   If `projectRoot` is empty, a dev-server URL (`devServer`) was used instead; fall back
   to the active project directory + `htmlSnippet`.
4. **Make the edit** the comment asks for, scoped to the selected element(s). Do not
   refactor surrounding code. For `mode: "multi"`, apply the comment to every element
   in `elements` (they were selected as a set — e.g. "increase spacing between these
   cards" applies to the shared container/gap).
5. **Stream progress back to the in-preview pin.** As you work, POST short notes to
   the request thread so they appear in the Figma-style comment popover anchored to
   the element:

   ```
   POST /apps/poke-and-prose/api/thread?id=<id>
   body: {"role": "agent", "text": "Editing styles.css — uppercasing .section-title"}
   ```

   Keep each note to one short line. Post one when you start, and one per meaningful
   step. When finished, post a final note **with a status** so the pin turns green:

   ```
   POST /apps/poke-and-prose/api/thread?id=<id>
   body: {"role": "agent", "text": "Done — added text-transform: uppercase", "status": "done"}
   ```

   Setting `"status": "done"` marks the request complete (pin turns green) while
   keeping the thread visible. Do NOT clear the request unless the user asks to
   dismiss it — clearing removes the pin. (Use `POST /clear?id=<id>` only to dismiss.)
6. Tell the user what you changed and in which file.

## Payload schema

```json
{
  "type": "visual_edit_request",
  "id": "1720560000000-a1b2c3",
  "createdAt": "2026-07-09T23:00:00Z",
  "selection": {
    "mode": "single | multi",
    "elements": [
      {
        "tag": "div",
        "id": "",
        "classes": ["card", "card--pricing"],
        "locator": "main > section:nth-of-type(2) > div:nth-of-type(3)",
        "boundingRect": { "x": 120, "y": 340, "width": 280, "height": 180 },
        "source": {
          "file": "src/components/PricingCard.tsx",
          "line": 42,
          "column": 6,
          "confidence": "high | medium | low"
        },
        "htmlSnippet": "<div class=\"card card--pricing\">…</div>",
        "relevantStyles": { "display": "flex", "gap": "12px", "position": "relative" }
      }
    ]
  },
  "comment": "increase spacing between these cards",
  "previewUrl": "http://localhost:5173/pricing",
  "thread": [
    { "role": "user", "text": "increase spacing between these cards", "ts": "2026-07-13T18:00:00Z" }
  ]
}
```

## Editing guidance

- The `file` path in `source` is **relative to the dev server project root**, not the
  KiroClaw workspace. Combine it with the user's active project directory to open it.
- Prefer editing the exact `line:col`; use `htmlSnippet`, `classes`, and `id` to
  disambiguate when a component is rendered in a `.map()` loop (same source line,
  many instances).
- Never guess a file when confidence is `low` — search first, then confirm.
- Keep edits minimal and reversible; the dev server hot-reloads, so the user sees
  the result immediately.
