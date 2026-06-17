import { describe, expect, test } from "bun:test";
import { contentRuntimeScript } from "../src/content-runtime";

describe("content runtime", () => {
  const script = contentRuntimeScript({ id: "demo-1234", viewerOrigin: "https://view.example" });

  test("is a single inline <script> with no eval / remote code / storage", () => {
    expect(script.startsWith("<script>")).toBe(true);
    expect(script.endsWith("</script>")).toBe(true);
    expect(script).not.toContain("eval(");
    expect(script).not.toContain("Function(");
    expect(script).not.toContain("import(");
    // No localStorage: it is denied to the opaque-origin sandboxed document. State lives on the
    // viewer origin; the runtime is a thin applier.
    expect(script).not.toContain("localStorage");
  });

  test("handshakes to the viewer's concrete origin and never targets a wildcard", () => {
    // Child initiates: posts to the concrete viewer origin and transfers a port. No "*".
    expect(script).toContain('"origin":"https://view.example"');
    expect(script).toContain("new MessageChannel()");
    expect(script).toContain("cfg.origin, [channel.port2]");
    // It reports its own page so the viewer can track in-iframe navigation across the opaque origin.
    expect(script).toContain("location.pathname");
    expect(script).not.toContain('"*"');
    // Tweak traffic flows over the port, so there is no window 'message' listener to attack.
    expect(script).not.toContain('addEventListener("message"');
  });

  test("stays inert when there is no viewer parent (standalone / top-level view)", () => {
    expect(script).toContain("window.parent === window");
  });

  test("applies the see:* protocol it receives over the port", () => {
    expect(script).toContain('"id":"demo-1234"');
    expect(script).toContain("see:hello");
    expect(script).toContain("see:state");
    expect(script).toContain("see:tweak");
    expect(script).toContain("see:reset");
    expect(script).toContain("see:clear");
  });

  test("applies tweak ops by target (css var, attr, class) and can undo them", () => {
    expect(script).toContain("applyOp");
    expect(script).toContain("undoOp");
    // css → inline var; attr → setAttribute (data-*/aria- guarded); class → classList.toggle.
    expect(script).toContain("setProperty");
    expect(script).toContain("setAttribute");
    expect(script).toContain("classList.toggle");
    // attr names are restricted to data-*/aria- in the runtime too (defense in depth).
    expect(script).toContain("data-|aria-");
    // Undo restores snapshotted attr/class state; css clears the inline var.
    expect(script).toContain("removeProperty");
  });

  test("ships an inspector: see:inspect drives it, picks report see:picked over the port", () => {
    // Inbound command + outbound report are both part of the point-to-point port protocol.
    expect(script).toContain("see:inspect");
    expect(script).toContain("see:picked");
    // Selectors prefer a stable data-see anchor over a positional path so the LLM gets a durable ref.
    expect(script).toContain("data-see");
    // Capture is via document-scoped pointer listeners, never a new window 'message' attack surface.
    expect(script).toContain('addEventListener("click"');
    expect(script).toContain('addEventListener("mousemove"');
    expect(script).not.toContain('addEventListener("message"');
    // Picks are emitted over the same transferred port — not a wildcard window.postMessage.
    expect(script).toContain("channel.port1.postMessage");
  });

  test("escapes < so a crafted config can never terminate the <script> element", () => {
    const evil = contentRuntimeScript({ id: "x", viewerOrigin: "a</script><b" });
    expect(evil).not.toContain("</script><b");
    expect(evil).toContain("\\u003c");
  });
});
