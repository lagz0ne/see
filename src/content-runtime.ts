// The content-side half of the `see:*` bridge — a minimal, self-contained runtime injected into
// every BUNDLE's served HTML on the content origin. It is a thin **applier**: it receives tweak
// state/commands from the viewer over a MessageChannel and applies them to :root. It holds NO
// storage and listens on NO window `message` event.
//
// Why a port handshake (not localStorage + window.postMessage)? In the managed viewer the content
// runs in an iframe sandboxed WITHOUT `allow-same-origin`, so its document has an **opaque origin**:
//   • browsers deny `localStorage`/`sessionStorage` to opaque origins, and
//   • a parent cannot postMessage to an opaque-origin child with a concrete `targetOrigin` (only
//     "*" would deliver, which the security contract forbids).
// So the CHILD initiates: it posts `see:hello` to the viewer's CONCRETE origin (gating the
// handshake to our viewer — a third-party embedder at another origin never receives it) and
// transfers one end of a MessageChannel. All further traffic is point-to-point over the port, so
// no `targetOrigin` is ever needed and no untrusted window can drive the runtime. Persistence lives
// on the viewer origin (real localStorage), which re-sends `see:state` on every page's handshake —
// that is what makes a visitor's tweaks survive navigation. A standalone/top-level view (no viewer
// parent) simply keeps the server's static <style> defaults.

export type ContentRuntimeConfig = {
  id: string; // share id — echoed in the handshake so the viewer can match its iframe
  viewerOrigin: string; // the concrete origin the handshake is sent to (never a wildcard)
};

// Bump when the injected runtime CODE — or the way it is injected — changes. The value is folded
// into the content ETag for injected bundle HTML (see app.ts contentEtag), so bumping it invalidates
// pages cached before the change instead of letting them 304 to a stale body. (Viewer-origin changes
// are handled automatically: the injected ETag also hashes the viewer origin baked into the runtime.)
export const CONTENT_RUNTIME_VERSION = 4;

// The runtime body as an inline-evaluated function expression. Dependency-free and ES5-ish so it
// runs inside any uploaded app with no build step. `cfg` is supplied by the IIFE call below.
const RUNTIME_BODY = `function (cfg) {
  "use strict";
  if (!cfg || typeof cfg.origin !== "string") return;
  if (!window.parent || window.parent === window) return; // standalone view — static <style> stands
  var root = document.documentElement;
  var MAX = 2048;

  function setVar(name, value) {
    if (typeof name !== "string" || name.slice(0, 2) !== "--") return;
    root.style.setProperty(name, String(value).slice(0, MAX));
  }
  function clearVar(name) { if (typeof name === "string") root.style.removeProperty(name); }

  // --- Tweak ops. A tweak applies to one of three targets: "css" (an inline :root var, layered over
  // the server's static <style>), "attr" (a data-*/aria- attribute on selected elements), or "class"
  // (a class toggled on selected elements). attr/class have no static default, so before first
  // applying one we snapshot the elements' original state and restore it on reset/clear.
  function truthy(v) { return v !== "" && v !== "0" && v !== "false" && v !== false; }
  // Defense in depth — mirror of bundle.ts SAFE_ATTR_NAME / SAFE_CLASS_NAME (keep in sync). Guards
  // against a tampered persisted op even though the server already validated these on write.
  function safeAttr(n) { return /^(data-|aria-)[a-zA-Z0-9:_-]+$/.test(n); }
  function safeClass(n) { return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(n); }
  function query(sel) { try { return document.querySelectorAll(sel); } catch (e) { return []; } }

  var snaps = {}; // opKey -> { t, name, items: [{ el, had, prev }] }
  function snapKey(op) { return JSON.stringify([op.t, op.selector, op.name]); }
  function ensureSnap(op, els) {
    var k = snapKey(op);
    if (snaps[k]) return;
    var items = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (op.t === "attr") items.push({ el: el, had: el.hasAttribute(op.name), prev: el.getAttribute(op.name) });
      else items.push({ el: el, had: el.classList.contains(op.name) });
    }
    snaps[k] = { t: op.t, name: op.name, items: items };
  }
  function restoreSnap(op) {
    var k = snapKey(op), s = snaps[k];
    if (!s) return;
    for (var i = 0; i < s.items.length; i++) {
      var it = s.items[i];
      if (s.t === "attr") { if (it.had) it.el.setAttribute(s.name, it.prev); else it.el.removeAttribute(s.name); }
      else it.el.classList.toggle(s.name, it.had);
    }
    delete snaps[k];
  }
  function applyOp(op) {
    if (!op || typeof op !== "object") return;
    if (op.t === "css") { setVar(op.cssVar, op.v); return; }
    if (typeof op.selector !== "string" || typeof op.name !== "string") return;
    var els = query(op.selector), i;
    if (op.t === "attr") {
      if (!safeAttr(op.name)) return;
      ensureSnap(op, els);
      for (i = 0; i < els.length; i++) {
        if (op.v === "") els[i].removeAttribute(op.name);
        else els[i].setAttribute(op.name, String(op.v).slice(0, MAX));
      }
    } else if (op.t === "class") {
      if (!safeClass(op.name)) return;
      ensureSnap(op, els);
      var on = truthy(op.v);
      for (i = 0; i < els.length; i++) els[i].classList.toggle(op.name, on);
    }
  }
  function undoOp(op) {
    if (!op || typeof op !== "object") return;
    if (op.t === "css") clearVar(op.cssVar);
    else restoreSnap(op);
  }

  var channel = new MessageChannel();

  // --- Inspect mode: highlight elements and report the picked element's selector to the viewer for
  // the comment -> clipboard -> LLM loop. Selectors prefer a data-see anchor, else a short CSS path
  // in the patch API's vocabulary so the LLM can act on them directly.
  var inspecting = false;
  var highlight = null;
  function box(el) {
    if (!highlight) {
      highlight = document.createElement("div");
      highlight.setAttribute("data-see-ui", "1");
      highlight.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #D97757;background:rgba(217,119,87,.12);border-radius:2px";
      (document.body || root).appendChild(highlight);
    }
    var r = el.getBoundingClientRect();
    highlight.style.left = r.left + "px"; highlight.style.top = r.top + "px";
    highlight.style.width = r.width + "px"; highlight.style.height = r.height + "px";
    highlight.style.display = "block";
  }
  function unbox() { if (highlight) { highlight.remove(); highlight = null; } }
  function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s; }
  function selectorFor(el) {
    var n = el;
    while (n && n.nodeType === 1) {
      var anchor = n.getAttribute && n.getAttribute("data-see");
      if (anchor) return "[data-see=" + JSON.stringify(anchor) + "]";
      n = n.parentElement;
    }
    var parts = []; n = el;
    while (n && n.nodeType === 1 && n.tagName !== "HTML" && parts.length < 6) {
      var tag = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(tag + "#" + esc(n.id)); break; }
      var p = n.parentElement, seg = tag;
      if (p) {
        var same = 0, idx = 0, i;
        for (i = 0; i < p.children.length; i++) {
          if (p.children[i].tagName === n.tagName) { same++; if (p.children[i] === n) idx = same; }
        }
        if (same > 1) seg += ":nth-of-type(" + idx + ")";
      }
      parts.unshift(seg);
      if (tag === "body") break;
      n = p;
    }
    return parts.join(" > ");
  }
  function labelFor(el) {
    var s = el.tagName ? el.tagName.toLowerCase() : "node";
    if (el.id) s += "#" + el.id; else if (el.classList && el.classList.length) s += "." + el.classList[0];
    var t = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (t) s += " - " + t.slice(0, 40);
    return s.slice(0, 80);
  }
  function onMove(e) { var el = e.target; if (el && el !== highlight && el.nodeType === 1) box(el); }
  function onClick(e) {
    var el = e.target;
    if (!el || el === highlight || el.nodeType !== 1) return;
    e.preventDefault(); e.stopPropagation();
    channel.port1.postMessage({ type: "see:picked", selector: selectorFor(el), label: labelFor(el) });
  }
  function setInspect(on) {
    if (!!on === inspecting) return;
    inspecting = !!on;
    if (inspecting) {
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      root.style.cursor = "crosshair";
    } else {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      root.style.cursor = "";
      unbox();
    }
  }

  channel.port1.onmessage = function (e) {
    var m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "see:state" && m.ops && m.ops.length) {
      // Per-op try/catch so one malformed op can't abort the whole replay batch (the rest must apply).
      for (var i = 0; i < m.ops.length; i++) { try { applyOp(m.ops[i]); } catch (e) {} }
    } else if (m.type === "see:tweak") {
      try { applyOp(m.op); } catch (e) {}
    } else if (m.type === "see:reset") {
      try { undoOp(m.op); } catch (e) {}
    } else if (m.type === "see:clear" && m.ops && m.ops.length) {
      for (var j = 0; j < m.ops.length; j++) { try { undoOp(m.ops[j]); } catch (e) {} }
    } else if (m.type === "see:inspect") {
      setInspect(m.on);
    }
  };

  // Concrete targetOrigin (the viewer) — never a wildcard. Only our viewer is at that origin, so a
  // third-party embedder never receives this. The transferred port is the secure command channel.
  // The path lets the viewer track in-iframe navigation (it can't read this cross-origin location):
  // each navigation reloads the runtime, which re-announces with the new path.
  try { window.parent.postMessage({ type: "see:hello", id: cfg.id, path: location.pathname }, cfg.origin, [channel.port2]); } catch (e) {}
}`;

// Build the inline <script> that boots the runtime with `config`. The config is serialized as JSON
// with "<" escaped so it can never terminate the <script> element; id and viewerOrigin are
// server-controlled (share-id pattern and a normalized URL), never attacker-supplied.
export function contentRuntimeScript(config: ContentRuntimeConfig): string {
  const payload = JSON.stringify({ id: config.id, origin: config.viewerOrigin }).replace(/</g, "\\u003c");
  return `<script>(${RUNTIME_BODY})(${payload});</script>`;
}
