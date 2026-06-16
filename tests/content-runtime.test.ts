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

  test("escapes < so a crafted config can never terminate the <script> element", () => {
    const evil = contentRuntimeScript({ id: "x", viewerOrigin: "a</script><b" });
    expect(evil).not.toContain("</script><b");
    expect(evil).toContain("\\u003c");
  });
});
