/*
 * Select-to-Edit — drop-in selection overlay for your dev server.
 *
 * Add this ONLY in dev builds (never ship to prod). It runs inside your app's
 * own page (same-origin), so it can read the DOM the parent preview panel can't.
 *
 * How to include (Vite example): add to index.html, dev-only:
 *   <script type="module" src="/@fs/ABS/PATH/inject/select-to-edit.js"></script>
 * or copy this file into your public/ dir and reference it, or inject via a
 * dev-only plugin. See README "Wiring the selection script".
 *
 * Behaviour (MVP):
 *   - Toggle select mode with a floating button (bottom-right) or Alt+S.
 *   - In select mode: hover highlights the element under the cursor.
 *   - Right-click selects it (native context menu suppressed) and opens a
 *     floating comment input anchored to the selection.
 *   - Enter submits (Shift+Enter = newline), Esc cancels.
 *   - On submit, assembles a `visual_edit_request` and posts it to the parent
 *     KiroClaw preview panel via postMessage. If not embedded, POSTs directly
 *     to a configured backend URL.
 *
 * Config (optional): set before this script loads —
 *   window.__KIRO_STE__ = { backend: "http://localhost:5476/apps/poke-and-prose/api" };
 */
(function () {
  "use strict";
  if (window.__KIRO_STE_LOADED__) return;
  window.__KIRO_STE_LOADED__ = true;

  var CFG = window.__KIRO_STE__ || {};
  var SNIPPET_MAX = 600;

  var state = { active: false, hover: null, selected: null };

  // ---- overlay elements ----
  var hoverBox = mkBox("#3b82f6", "rgba(59,130,246,0.12)");
  var selBox = mkBox("#8b5cf6", "rgba(139,92,246,0.18)");
  selBox.style.display = "none";
  hoverBox.style.display = "none";

  var toggleBtn = document.createElement("button");
  toggleBtn.textContent = "◎ Select to Edit";
  css(toggleBtn, {
    position: "fixed", zIndex: 2147483646, right: "16px", bottom: "16px",
    padding: "8px 12px", borderRadius: "8px", border: "1px solid #8b5cf6",
    background: "#1e1b2e", color: "#e9e7ff", font: "600 12px system-ui, sans-serif",
    cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,.35)",
  });
  toggleBtn.addEventListener("click", function () { setActive(!state.active); });

  var input = null; // floating comment input container

  function mount() {
    document.body.appendChild(hoverBox);
    document.body.appendChild(selBox);
    document.body.appendChild(toggleBtn);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  // ---- mode toggle ----
  function setActive(on) {
    state.active = on;
    toggleBtn.style.background = on ? "#8b5cf6" : "#1e1b2e";
    toggleBtn.style.color = on ? "#fff" : "#e9e7ff";
    hoverBox.style.display = "none";
    if (!on) clearSelection();
  }

  document.addEventListener("keydown", function (e) {
    if (e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      setActive(!state.active);
    } else if (e.key === "Escape") {
      if (state.selected) clearSelection();
      else if (state.active) setActive(false);
    }
  });

  // ---- hover ----
  document.addEventListener(
    "mousemove",
    function (e) {
      if (!state.active || state.selected) return;
      var el = elementAt(e);
      if (!el || el === state.hover) return;
      state.hover = el;
      positionBox(hoverBox, el);
      hoverBox.style.display = "block";
    },
    true
  );

  // ---- right-click select ----
  document.addEventListener(
    "contextmenu",
    function (e) {
      if (!state.active) return;
      e.preventDefault();
      e.stopPropagation();
      var el = elementAt(e);
      if (!el) return;
      selectElement(el);
    },
    true
  );

  function elementAt(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.body || el === document.documentElement) return null;
    if (isOurs(el)) return null;
    return el;
  }

  function isOurs(el) {
    return (
      el === toggleBtn ||
      el === hoverBox ||
      el === selBox ||
      (input && input.contains(el))
    );
  }

  // ---- selection + floating input ----
  function selectElement(el) {
    state.selected = el;
    state.hover = null;
    hoverBox.style.display = "none";
    positionBox(selBox, el);
    selBox.style.display = "block";
    startLiveTracking();
    openInput(el);
  }

  function clearSelection() {
    state.selected = null;
    selBox.style.display = "none";
    stopLiveTracking();
    if (input) {
      input.remove();
      input = null;
    }
  }

  function openInput(el) {
    if (input) input.remove();
    input = document.createElement("div");
    css(input, {
      position: "fixed", zIndex: 2147483647, width: "300px",
      background: "#141220", border: "1px solid #8b5cf6", borderRadius: "10px",
      padding: "10px", boxShadow: "0 8px 30px rgba(0,0,0,.5)",
      font: "13px system-ui, sans-serif", color: "#e9e7ff",
    });

    var summary = document.createElement("div");
    summary.textContent = describe(el);
    css(summary, { fontSize: "11px", opacity: 0.7, marginBottom: "6px" });

    var ta = document.createElement("textarea");
    ta.placeholder = "Describe the change… (Enter to send, Shift+Enter for newline)";
    css(ta, {
      width: "100%", minHeight: "48px", resize: "vertical", boxSizing: "border-box",
      background: "#0d0b16", color: "#fff", border: "1px solid #2a2740",
      borderRadius: "6px", padding: "8px", font: "13px system-ui, sans-serif",
    });

    var row = document.createElement("div");
    css(row, { display: "flex", gap: "6px", justifyContent: "flex-end", marginTop: "8px" });
    var cancel = mkBtn("Cancel", "#2a2740", function () { clearSelection(); });
    var send = mkBtn("Send →", "#8b5cf6", function () { submit(el, ta.value); });
    row.appendChild(cancel);
    row.appendChild(send);

    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit(el, ta.value);
      }
    });

    input.appendChild(summary);
    input.appendChild(ta);
    input.appendChild(row);
    document.body.appendChild(input);
    positionInput(el);
    ta.focus();
  }

  function positionInput(el) {
    if (!input) return;
    var r = el.getBoundingClientRect();
    var w = 300, h = input.offsetHeight || 120, gap = 8;
    var left = Math.min(r.left, window.innerWidth - w - 8);
    var top = r.bottom + gap;
    if (top + h > window.innerHeight) top = Math.max(8, r.top - h - gap);
    input.style.left = Math.max(8, left) + "px";
    input.style.top = top + "px";
  }

  // ---- live tracking of the highlight while a selection is open ----
  var rafId = null;
  function startLiveTracking() {
    stopLiveTracking();
    var tick = function () {
      if (!state.selected) return;
      if (!state.selected.isConnected) {
        // element vanished on hot-reload — clear rather than point at stale node
        clearSelection();
        return;
      }
      positionBox(selBox, state.selected);
      positionInput(state.selected);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }
  function stopLiveTracking() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // ---- payload assembly ----
  function buildElementPayload(el) {
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var relevant = {};
    [
      "display", "position", "top", "right", "bottom", "left",
      "margin", "padding", "gap", "flexDirection", "justifyContent",
      "alignItems", "gridTemplateColumns", "width", "height",
      "fontSize", "color", "backgroundColor", "borderRadius",
    ].forEach(function (k) {
      var v = cs[k];
      if (v && v !== "normal" && v !== "auto" && v !== "none") relevant[k] = v;
    });

    var source = resolveSource(el);
    var html = el.outerHTML || "";
    if (html.length > SNIPPET_MAX) html = html.slice(0, SNIPPET_MAX) + "…";

    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      classes: Array.prototype.slice.call(el.classList),
      boundingRect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      source: source,
      htmlSnippet: html,
      relevantStyles: relevant,
    };
  }

  // Source mapping, in confidence order.
  function resolveSource(el) {
    // 1. Build-time plugin attribute (preferred, high confidence).
    var ds = el.getAttribute && el.getAttribute("data-kiro-source");
    if (ds) {
      var m = /^(.*):(\d+):(\d+)$/.exec(ds);
      if (m) return { file: m[1], line: +m[2], column: +m[3], confidence: "high" };
    }
    // 2. React Fiber _debugSource (dev builds only, medium confidence).
    try {
      var key = Object.keys(el).find(function (k) {
        return k.indexOf("__reactFiber") === 0 || k.indexOf("__reactInternalInstance") === 0;
      });
      if (key) {
        var fiber = el[key];
        var dbg = fiber && (fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource));
        if (dbg && dbg.fileName) {
          return { file: dbg.fileName, line: dbg.lineNumber || 0, column: dbg.columnNumber || 0, confidence: "medium" };
        }
      }
    } catch (_) {}
    // 3. No mapping — low confidence, rely on htmlSnippet.
    return { file: "", line: 0, column: 0, confidence: "low" };
  }

  function submit(el, comment) {
    comment = (comment || "").trim();
    if (!comment) return;
    var payload = {
      type: "visual_edit_request",
      createdAt: new Date().toISOString(),
      selection: { mode: "single", elements: [buildElementPayload(el)] },
      comment: comment,
      previewUrl: location.href,
    };
    deliver(payload);
    clearSelection();
  }

  function deliver(payload) {
    var embedded = window.parent && window.parent !== window;
    if (embedded) {
      window.parent.postMessage({ source: "kiro-select-to-edit", payload: payload }, "*");
      return;
    }
    // Standalone (not in the KiroClaw preview iframe): POST directly if configured.
    if (CFG.backend) {
      fetch(CFG.backend.replace(/\/$/, "") + "/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(function (e) { console.warn("[select-to-edit] deliver failed", e); });
    } else {
      console.warn("[select-to-edit] no parent frame and no window.__KIRO_STE__.backend configured; payload:", payload);
    }
  }

  // ---- utilities ----
  function describe(el) {
    var t = el.tagName.toLowerCase();
    if (el.id) return t + "#" + el.id;
    if (el.classList.length) return t + "." + Array.prototype.slice.call(el.classList).slice(0, 2).join(".");
    return t + " element selected";
  }
  function positionBox(box, el) {
    var r = el.getBoundingClientRect();
    css(box, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  }
  function mkBox(border, fill) {
    var b = document.createElement("div");
    css(b, {
      position: "fixed", zIndex: 2147483645, pointerEvents: "none",
      border: "2px solid " + border, background: fill, borderRadius: "3px",
      transition: "none",
    });
    return b;
  }
  function mkBtn(label, bg, onClick) {
    var b = document.createElement("button");
    b.textContent = label;
    css(b, {
      padding: "6px 10px", borderRadius: "6px", border: "none", cursor: "pointer",
      background: bg, color: "#fff", font: "600 12px system-ui, sans-serif",
    });
    b.addEventListener("click", onClick);
    return b;
  }
  function css(el, styles) {
    for (var k in styles) el.style[k] = styles[k];
  }
})();
