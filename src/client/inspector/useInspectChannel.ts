import { useCallback, useEffect, useRef, useState } from "react";
import {
  NS,
  PROTO,
  type Capability,
  type InspectTarget,
  type TweakDef,
  type TweakValue,
  grantCapabilities,
  isHelloMessage,
  isSeeMessage,
  isTargetsMessage,
  isTweaksMessage,
  sanitizeTargets,
  sanitizeTweaks,
} from "./protocol";

type InspectChannel = {
  /** Capabilities the page announced and the parent allowlist granted. */
  granted: Set<Capability>;
  /** Latest inspectable element rects (iframe-content CSS px), only while inspect is enabled. */
  targets: InspectTarget[];
  /** Tweak controls the page exposed (empty until a tweaks-capable page announces them). */
  tweaks: TweakDef[];
  /** Tell the page to start/stop reporting targets. */
  enableInspect: () => void;
  disableInspect: () => void;
  /** Push a new value for a tweak to the page; optimistically updates the local control. */
  setTweak: (id: string, value: TweakValue) => void;
  /** Probe the page to re-announce (covers the bar mounting / the iframe navigating). */
  requestHello: () => void;
};

// Owns the parent side of the see-inspect protocol: validates inbound messages, tracks the
// handshake, and posts control messages to the iframe. The iframe's contentWindow is re-read on
// every message so in-iframe navigation (which re-runs the SDK and re-sends `hello`) is handled.
export function useInspectChannel(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  expectedContentOrigin: string,
): InspectChannel {
  const [granted, setGranted] = useState<Set<Capability>>(() => new Set());
  const [targets, setTargets] = useState<InspectTarget[]>([]);
  const [tweaks, setTweaks] = useState<TweakDef[]>([]);
  // Mirror granted in a ref so post helpers don't need it as a dependency.
  const parentOriginRef = useRef(expectedContentOrigin);
  parentOriginRef.current = expectedContentOrigin;

  const postToFrame = useCallback(
    (message: Record<string, unknown>) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame) {
        return;
      }
      // The sandboxed frame's origin is "null", which postMessage cannot target by string, so
      // "*" is required here. This is safe: control messages carry no secrets, and the frame's
      // SDK still validates that the message came from window.parent.
      frame.postMessage({ ns: NS, proto: PROTO, ...message }, "*");
    },
    [iframeRef],
  );

  const ackCapabilities = useCallback(
    (capabilities: Capability[]) => {
      postToFrame({ type: "ack", capabilities });
    },
    [postToFrame],
  );

  const enableInspect = useCallback(() => postToFrame({ type: "inspect-enable" }), [postToFrame]);
  const disableInspect = useCallback(() => postToFrame({ type: "inspect-disable" }), [postToFrame]);
  const requestHello = useCallback(() => postToFrame({ type: "hello-request" }), [postToFrame]);
  const setTweak = useCallback(
    (id: string, value: TweakValue) => {
      postToFrame({ type: "tweak-set", id, value });
      setTweaks((prev) => prev.map((tweak) => (tweak.id === id ? { ...tweak, value } : tweak)));
    },
    [postToFrame],
  );

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Identity is the real gate: a sandboxed, no-same-origin iframe reports origin "null", so
      // only `event.source === contentWindow` reliably binds a message to our frame.
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame) {
        return;
      }
      // Secondary origin filter: accept the expected content origin, or "null" (the sandboxed
      // frame), but never an arbitrary third-party origin even if it somehow shares the source.
      if (event.origin !== parentOriginRef.current && event.origin !== "null") {
        return;
      }
      const data = event.data;
      if (!isSeeMessage(data)) {
        return;
      }

      if (isHelloMessage(data)) {
        const grantedList = grantCapabilities(data.capabilities);
        setGranted(new Set(grantedList));
        setTargets([]);
        // Keep any tweaks already received; a tweaks-capable page sends them right after hello.
        ackCapabilities(grantedList);
        return;
      }
      if (isTargetsMessage(data)) {
        setTargets(sanitizeTargets(data.targets));
        return;
      }
      if (isTweaksMessage(data)) {
        setTweaks(sanitizeTweaks(data.tweaks));
        return;
      }
      if (data.type === "bye") {
        setGranted(new Set());
        setTargets([]);
        setTweaks([]);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [iframeRef, ackCapabilities]);

  // Probe once on mount so the bar discovers a page that loaded before it (the page also
  // announces on its own load, covering the opposite order).
  useEffect(() => {
    requestHello();
  }, [requestHello]);

  // Tell the page to stop reporting when the viewer unmounts.
  useEffect(() => {
    return () => {
      disableInspect();
    };
  }, [disableInspect]);

  return { granted, targets, tweaks, enableInspect, disableInspect, setTweak, requestHello };
}
