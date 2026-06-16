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
export const CONTENT_RUNTIME_VERSION = 2;

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
