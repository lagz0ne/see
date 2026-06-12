/*
 * see-inspect SDK — opt-in capability bridge for pages shared through `see`.
 *
 * Include it from the uploaded page with a single tag:
 *
 *   <script src="https://YOUR-SEE-HOST/sdk/see-inspect.js" data-see-capabilities="inspect"></script>
 *
 * Then mark the elements you want the inspector bar to be able to select/capture:
 *
 *   <section data-see-inspectable data-see-id="hero" data-see-label="Hero banner"> ... </section>
 *
 * The SDK runs inside the sandboxed, cross-origin iframe and talks to the parent viewer over
 * postMessage only — it can never read or script the parent. It announces a constrained,
 * hardcoded allowlist of capabilities; the parent intersects that with its own allowlist and
 * only ever surfaces matching tools (chrome-extension style). No data leaves the page except
 * the capability list and the bounding rectangles of elements you explicitly marked.
 *
 * Keep NS / PROTO / SDK_ALLOWED_CAPABILITIES in sync with src/client/inspector/protocol.ts.
 */
(function () {
  "use strict";

  var NS = "see-inspect";
  var PROTO = 1;
  var SDK_VERSION = "1";
  var SDK_ALLOWED_CAPABILITIES = ["inspect"];

  // Only run inside an iframe.
  if (window.parent === window) {
    return;
  }

  var scriptEl = document.currentScript;

  function announcedCapabilities() {
    var raw = (scriptEl && scriptEl.getAttribute("data-see-capabilities")) || "inspect";
    var requested = raw
      .split(",")
      .map(function (value) {
        return value.trim();
      })
      .filter(Boolean);
    var result = [];
    for (var i = 0; i < requested.length; i += 1) {
      if (SDK_ALLOWED_CAPABILITIES.indexOf(requested[i]) !== -1 && result.indexOf(requested[i]) === -1) {
        result.push(requested[i]);
      }
    }
    return result.length ? result : ["inspect"];
  }

  var capabilities = announcedCapabilities();
  var parentOrigin = null; // locked on first valid inbound parent message
  var inspectActive = false;
  var rafScheduled = false;
  var mutationObserver = null;

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

  function collectTargets() {
    var nodes = document.querySelectorAll("[data-see-inspectable]");
    var targets = [];
    for (var i = 0; i < nodes.length && targets.length < 200; i += 1) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      targets.push({
        // getBoundingClientRect is viewport-relative CSS px — exactly what the parent maps.
        seeId: el.getAttribute("data-see-id") || "see-target-" + i,
        seeLabel: el.getAttribute("data-see-label") || el.getAttribute("data-see-id") || el.tagName.toLowerCase(),
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });
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
      case "inspect-enable":
        enableInspect();
        break;
      case "inspect-disable":
        disableInspect();
        break;
      default:
        break;
    }
  });

  window.addEventListener("pagehide", function () {
    disableInspect();
    post({ ns: NS, proto: PROTO, type: "bye" }, false);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendHello, { once: true });
  } else {
    sendHello();
  }
})();
