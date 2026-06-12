/*
 * see-inspect SDK — opt-in capability bridge for pages shared through `see`.
 *
 * Include it from the uploaded page with a single tag:
 *
 *   <script src="https://YOUR-SEE-HOST/sdk/see-inspect.js" data-see-capabilities="inspect,tweaks"></script>
 *
 * Capabilities (request the ones you use via data-see-capabilities):
 *
 *  • inspect — mark elements the inspector bar can highlight, select, and screenshot:
 *      <section data-see-inspectable data-see-id="hero" data-see-label="Hero banner"> ... </section>
 *
 *  • tweaks — live design controls rendered in the inspector bar. Declare defaults in ONE
 *    root-level inline script using edit-mode markers (Claude Design convention):
 *      <script>
 *        const TWEAK_DEFAULTS = /*EDITMODE-BEGIN* /{ "primaryColor": "#D97757", "fontSize": 16, "dark": false }/*EDITMODE-END* /;
 *      </script>
 *    The bar infers a control per value (boolean→toggle, number→slider, #hex→color, else text).
 *    Optionally enrich with a global `window.SeeTweaks` map keyed by the same names
 *    ({ fontSize: { kind:"number", min:12, max:24, step:1, unit:"px", label:"Font size", group:"Type" },
 *       accent: { kind:"color", cssVar:"--accent" }, variant: { kind:"select", options:["A","B","C"] } }).
 *    To apply a change, define `function applyLive(id, value){...}`; or set `cssVar` in SeeTweaks
 *    metadata and the SDK sets that CSS variable for you.
 *
 * The SDK runs inside the sandboxed, cross-origin iframe and talks to the parent over postMessage
 * only — it can never read or script the parent. The bar only ever surfaces capabilities it
 * already understands. No data leaves the page except the capability list, the rects of elements
 * you marked, and the tweak schema you declared.
 *
 * Keep NS / PROTO / SDK_ALLOWED_CAPABILITIES in sync with src/client/inspector/protocol.ts.
 */
(function () {
  "use strict";

  var NS = "see-inspect";
  var PROTO = 1;
  var SDK_VERSION = "1";
  var SDK_ALLOWED_CAPABILITIES = ["inspect", "tweaks"];

  // Only run inside an iframe.
  if (window.parent === window) {
    return;
  }

  var scriptEl = document.currentScript;

  // When the page is served as a `see` bundle, the platform injects window.__SEE_BUNDLE__
  // (capabilities, tweak defs+values, inspect selectors). It takes precedence over the
  // legacy in-page wiring (data attributes, TWEAK_DEFAULTS, window.SeeTweaks).
  function bundleConfig() {
    return window.__SEE_BUNDLE__ && typeof window.__SEE_BUNDLE__ === "object" ? window.__SEE_BUNDLE__ : null;
  }

  function announcedCapabilities() {
    var bundle = bundleConfig();
    var requested;
    if (bundle && Array.isArray(bundle.capabilities)) {
      requested = bundle.capabilities.slice();
    } else {
      var raw = (scriptEl && scriptEl.getAttribute("data-see-capabilities")) || "inspect";
      requested = raw
        .split(",")
        .map(function (value) {
          return value.trim();
        })
        .filter(Boolean);
    }
    var result = [];
    for (var i = 0; i < requested.length; i += 1) {
      if (SDK_ALLOWED_CAPABILITIES.indexOf(requested[i]) !== -1 && result.indexOf(requested[i]) === -1) {
        result.push(requested[i]);
      }
    }
    return result.length ? result : ["inspect"];
  }

  var capabilities = announcedCapabilities();
  var hasTweaks = capabilities.indexOf("tweaks") !== -1;
  var parentOrigin = null; // locked on first valid inbound parent message
  var inspectActive = false;
  var rafScheduled = false;
  var mutationObserver = null;
  var tweakValues = loadSavedTweaks();

  function post(message, fallbackToWildcard) {
    var targetOrigin = parentOrigin || (fallbackToWildcard ? "*" : null);
    if (!targetOrigin) {
      return;
    }
    try {
      window.parent.postMessage(message, targetOrigin);
    } catch (error) {
      // Parent gone or origin mismatch — ignore.
    }
  }

  function sendHello() {
    // The page may not know the parent origin yet, so the initial hello is allowed to use "*".
    // It only exposes the capability list and current URL, which are non-sensitive.
    post(
      {
        ns: NS,
        proto: PROTO,
        type: "hello",
        capabilities: capabilities,
        sdkVersion: SDK_VERSION,
        pageUrl: location.href,
      },
      true,
    );
  }

  // ---- inspect -------------------------------------------------------------

  function collectTargets() {
    var targets = [];
    var seen = [];

    function pushTarget(el, id, label) {
      if (targets.length >= 200 || seen.indexOf(el) !== -1) {
        return;
      }
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      seen.push(el);
      targets.push({
        // getBoundingClientRect is viewport-relative CSS px — exactly what the parent maps.
        seeId: id || el.getAttribute("data-see-id") || "see-target-" + targets.length,
        seeLabel: label || el.getAttribute("data-see-label") || el.getAttribute("data-see-id") || el.tagName.toLowerCase(),
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });
    }

    // Legacy: elements marked in the page itself.
    var nodes = document.querySelectorAll("[data-see-inspectable]");
    for (var i = 0; i < nodes.length; i += 1) {
      pushTarget(nodes[i]);
    }

    // Bundle: targets declared by selector in see.json.
    var bundle = bundleConfig();
    if (bundle && Array.isArray(bundle.inspect)) {
      for (var j = 0; j < bundle.inspect.length; j += 1) {
        var entry = bundle.inspect[j];
        if (!entry || typeof entry.selector !== "string") {
          continue;
        }
        var matched;
        try {
          matched = document.querySelectorAll(entry.selector);
        } catch (error) {
          continue; // invalid selector — skip
        }
        for (var m = 0; m < matched.length; m += 1) {
          pushTarget(matched[m], entry.id, entry.label);
        }
      }
    }

    return targets;
  }

  function sendTargets() {
    if (!inspectActive) {
      return;
    }
    post({ ns: NS, proto: PROTO, type: "targets", targets: collectTargets() }, false);
  }

  function scheduleTargets() {
    if (rafScheduled || !inspectActive) {
      return;
    }
    rafScheduled = true;
    requestAnimationFrame(function () {
      rafScheduled = false;
      sendTargets();
    });
  }

  function enableInspect() {
    if (inspectActive) {
      sendTargets();
      return;
    }
    inspectActive = true;
    window.addEventListener("scroll", scheduleTargets, true);
    window.addEventListener("resize", scheduleTargets);
    if (typeof MutationObserver === "function") {
      mutationObserver = new MutationObserver(scheduleTargets);
      mutationObserver.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    }
    sendTargets();
  }

  function disableInspect() {
    if (!inspectActive) {
      return;
    }
    inspectActive = false;
    window.removeEventListener("scroll", scheduleTargets, true);
    window.removeEventListener("resize", scheduleTargets);
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  }

  // ---- tweaks --------------------------------------------------------------

  function loadSavedTweaks() {
    try {
      var saved = JSON.parse(localStorage.getItem("tweaks") || "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch (error) {
      return {};
    }
  }

  // Find the page's TWEAK_DEFAULTS — either on window, or parsed from the EDITMODE-marked inline
  // script. The SDK runs in the page, so reading its own inline scripts is allowed.
  function readTweakDefaults() {
    // Bundle takes precedence: its tweaks map carries each value alongside the control def.
    var bundle = bundleConfig();
    if (bundle && bundle.tweaks && typeof bundle.tweaks === "object") {
      var defaults = {};
      for (var key in bundle.tweaks) {
        if (Object.prototype.hasOwnProperty.call(bundle.tweaks, key) && bundle.tweaks[key]) {
          defaults[key] = bundle.tweaks[key].value;
        }
      }
      return defaults;
    }
    if (window.TWEAK_DEFAULTS && typeof window.TWEAK_DEFAULTS === "object") {
      return window.TWEAK_DEFAULTS;
    }
    var scripts = document.getElementsByTagName("script");
    var begin = "/*EDITMODE-BEGIN*/";
    var end = "/*EDITMODE-END*/";
    for (var i = 0; i < scripts.length; i += 1) {
      var text = scripts[i].textContent || "";
      var b = text.indexOf(begin);
      var e = text.indexOf(end);
      if (b !== -1 && e !== -1 && e > b) {
        try {
          return JSON.parse(text.slice(b + begin.length, e));
        } catch (error) {
          return null;
        }
      }
    }
    return null;
  }

  function tweakMeta(id) {
    // Bundle def includes the control metadata (kind/min/max/cssVar/…); the extra `value`
    // field is ignored by callers. Falls back to the page's window.SeeTweaks map.
    var bundle = bundleConfig();
    if (bundle && bundle.tweaks && bundle.tweaks[id]) {
      return bundle.tweaks[id];
    }
    return (window.SeeTweaks && typeof window.SeeTweaks === "object" && window.SeeTweaks[id]) || {};
  }

  function inferKind(value, meta) {
    if (meta && typeof meta.kind === "string") {
      return meta.kind;
    }
    if (meta && Array.isArray(meta.options)) {
      return "select";
    }
    if (typeof value === "boolean") {
      return "toggle";
    }
    if (typeof value === "number") {
      return "number";
    }
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? "color" : "text";
  }

  function titleCase(key) {
    return key
      .replace(/[-_]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function buildTweakDefs() {
    var defaults = readTweakDefaults();
    if (!defaults || typeof defaults !== "object") {
      return [];
    }
    var defs = [];
    for (var key in defaults) {
      if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
        continue;
      }
      var fallback = defaults[key];
      if (typeof fallback !== "string" && typeof fallback !== "number" && typeof fallback !== "boolean") {
        continue;
      }
      var meta = tweakMeta(key);
      var current = Object.prototype.hasOwnProperty.call(tweakValues, key) ? tweakValues[key] : fallback;
      defs.push({
        id: key,
        label: typeof meta.label === "string" ? meta.label : titleCase(key),
        kind: inferKind(current, meta),
        value: current,
        min: typeof meta.min === "number" ? meta.min : undefined,
        max: typeof meta.max === "number" ? meta.max : undefined,
        step: typeof meta.step === "number" ? meta.step : undefined,
        unit: typeof meta.unit === "string" ? meta.unit : undefined,
        options: Array.isArray(meta.options) ? meta.options : undefined,
        group: typeof meta.group === "string" ? meta.group : undefined,
      });
    }
    return defs;
  }

  function sendTweaks() {
    if (!hasTweaks) {
      return;
    }
    post({ ns: NS, proto: PROTO, type: "tweaks", tweaks: buildTweakDefs() }, false);
  }

  function setCssVar(name, value, unit) {
    var out;
    if (typeof value === "boolean") {
      out = value ? "1" : "0";
    } else if (typeof value === "number" && unit) {
      out = String(value) + unit;
    } else {
      out = String(value);
    }
    document.documentElement.style.setProperty(name, out);
  }

  function applyTweak(id, value) {
    tweakValues[id] = value;
    var meta = tweakMeta(id);
    if (typeof window.applyLive === "function") {
      try {
        window.applyLive(id, value);
      } catch (error) {
        // Page handler threw — ignore.
      }
    } else if (typeof meta.cssVar === "string") {
      setCssVar(meta.cssVar, value, meta.unit);
    } else {
      setCssVar("--tweak-" + id, value, meta.unit);
    }
    try {
      localStorage.setItem("tweaks", JSON.stringify(tweakValues));
    } catch (error) {
      // Storage unavailable — ignore.
    }
  }

  // Re-apply any locally-saved tweak values so a returning visitor keeps them. The host may then
  // push its own saved-to-share values via tweak-set, which take precedence (they arrive later).
  function applySavedTweaks() {
    if (!hasTweaks) {
      return;
    }
    for (var key in tweakValues) {
      if (Object.prototype.hasOwnProperty.call(tweakValues, key)) {
        applyTweak(key, tweakValues[key]);
      }
    }
  }

  // ---- channel -------------------------------------------------------------

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.ns !== NS || data.proto !== PROTO || typeof data.type !== "string") {
      return;
    }
    // The trusted parent is whichever window holds this iframe.
    if (event.source !== window.parent) {
      return;
    }
    // Lock to the first valid parent origin; reject any mismatch afterwards.
    if (parentOrigin === null) {
      if (event.origin && event.origin !== "null") {
        parentOrigin = event.origin;
      }
    } else if (event.origin !== parentOrigin) {
      return;
    }

    switch (data.type) {
      case "ack":
        // Parent acknowledged; nothing required, handshake is complete.
        break;
      case "hello-request":
        // The bar (re)mounted and is probing — re-announce so it can match us.
        sendHello();
        sendTweaks();
        break;
      case "inspect-enable":
        enableInspect();
        break;
      case "inspect-disable":
        disableInspect();
        break;
      case "tweak-set":
        if (hasTweaks && typeof data.id === "string") {
          applyTweak(data.id, data.value);
        }
        break;
      default:
        break;
    }
  });

  window.addEventListener("pagehide", function () {
    disableInspect();
    post({ ns: NS, proto: PROTO, type: "bye" }, false);
  });

  function announce() {
    applySavedTweaks();
    sendHello();
    sendTweaks();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announce, { once: true });
  } else {
    announce();
  }
})();
