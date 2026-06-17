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
export const CONTENT_RUNTIME_VERSION = 3;

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
    if (m.type === "see:state" && m.vars && typeof m.vars === "object") {
      for (var k in m.vars) { if (Object.prototype.hasOwnProperty.call(m.vars, k)) setVar(k, m.vars[k]); }
    } else if (m.type === "see:tweak") {
      setVar(m.cssVar, m.value);
    } else if (m.type === "see:reset") {
      clearVar(m.cssVar);
    } else if (m.type === "see:clear" && m.cssVars && m.cssVars.length) {
      for (var i = 0; i < m.cssVars.length; i++) clearVar(m.cssVars[i]);
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
