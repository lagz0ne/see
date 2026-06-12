import { describe, expect, test } from "bun:test";
import { contentRectToParentRect, mapRectToDevicePixels } from "../src/client/inspector/captureSelection";
import { grantCapabilities, sanitizeTargets } from "../src/client/inspector/protocol";

describe("inspector capability protocol", () => {
  test("grantCapabilities intersects announced capabilities with the allowlist", () => {
    expect(grantCapabilities(["inspect", "exfiltrate", "inspect"])).toEqual(["inspect"]);
    expect(grantCapabilities(["navigate", "screenshot"])).toEqual([]);
    expect(grantCapabilities([])).toEqual([]);
  });

  test("sanitizeTargets drops malformed rects and fills missing labels", () => {
    const targets = sanitizeTargets([
      { seeId: "a", seeLabel: "A", rect: { x: 1, y: 2, width: 3, height: 4 } },
      { seeId: "zero", rect: { x: 0, y: 0, width: 0, height: 10 } }, // zero width -> dropped
      { rect: { x: 1, y: 1, width: Number.POSITIVE_INFINITY, height: 2 } }, // non-finite -> dropped
      "garbage",
      null,
    ]);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ seeId: "a", seeLabel: "A", rect: { x: 1, y: 2, width: 3, height: 4 } });
  });

  test("sanitizeTargets synthesizes a stable id when the page omits one", () => {
    const targets = sanitizeTargets([{ rect: { x: 0, y: 0, width: 10, height: 10 } }]);
    expect(targets[0].seeId).toBe("target-0");
  });
});

describe("inspector coordinate mapping", () => {
  test("contentRectToParentRect applies the iframe's on-screen scale and offset", () => {
    // A 390-wide frame rendered at 0.5 scale, offset (100, 50) in the parent viewport.
    const iframeRect = { left: 100, top: 50, width: 195, height: 390 } as unknown as DOMRect;
    const parent = contentRectToParentRect({ x: 10, y: 20, width: 40, height: 30 }, iframeRect, 390);

    expect(parent.left).toBeCloseTo(105);
    expect(parent.top).toBeCloseTo(60);
    expect(parent.width).toBeCloseTo(20);
    expect(parent.height).toBeCloseTo(15);
  });

  test("mapRectToDevicePixels scales by the frame/viewport ratio (folds in DPR)", () => {
    // Captured frame is 2x the CSS viewport (e.g. devicePixelRatio 2).
    const crop = mapRectToDevicePixels(
      { left: 100, top: 50, width: 200, height: 100 },
      { width: 2560, height: 1440 },
      { innerWidth: 1280, innerHeight: 720 },
    );
    expect(crop).toEqual({ x: 200, y: 100, width: 400, height: 200 });
  });

  test("mapRectToDevicePixels clamps a selection that runs past the frame", () => {
    const crop = mapRectToDevicePixels(
      { left: 1200, top: 700, width: 400, height: 400 },
      { width: 1280, height: 720 },
      { innerWidth: 1280, innerHeight: 720 },
    );
    expect(crop).toEqual({ x: 1200, y: 700, width: 80, height: 20 });
  });
});
