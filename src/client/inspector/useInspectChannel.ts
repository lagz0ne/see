import { useCallback, useEffect, useRef, useState } from "react";
import {
  NS,
  PROTO,
  type Capability,
  type InspectTarget,
  grantCapabilities,
  isHelloMessage,
  isSeeMessage,
  isTargetsMessage,
  sanitizeTargets,
} from "./protocol";

type InspectChannel = {
  /** Capabilities the page announced and the parent allowlist granted. */
  granted: Set<Capability>;
  /** Latest inspectable element rects (iframe-content CSS px), only while inspect is enabled. */
  targets: InspectTarget[];
  /** Tell the page to start/stop reporting targets. */
  enableInspect: () => void;
  disableInspect: () => void;
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
        ackCapabilities(grantedList);
        return;
      }
      if (isTargetsMessage(data)) {
        setTargets(sanitizeTargets(data.targets));
        return;
      }
      if (data.type === "bye") {
        setGranted(new Set());
        setTargets([]);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [iframeRef, ackCapabilities]);

  // Tell the page to stop reporting when the viewer unmounts.
  useEffect(() => {
    return () => {
      disableInspect();
    };
  }, [disableInspect]);

  return { granted, targets, enableInspect, disableInspect };
}
