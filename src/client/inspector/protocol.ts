// Capability protocol between the uploaded page (inside the sandboxed, cross-origin iframe)
// and the inspector bar (the parent viewer app). The page opts in via the SDK in
// `src/sdk/see-inspect.js`, which speaks this same protocol. Because the SDK runs in the
// content origin and cannot import this module, it duplicates the `NS`, `PROTO`, and
// capability constants below — keep the two in sync.
//
// Security model: the iframe has `sandbox="allow-scripts ..."` WITHOUT `allow-same-origin`,
// so the only channel is `postMessage` and the page can never read or script the parent.
// The parent treats everything the page sends as untrusted data — rects are used only to
// draw overlay boxes and crop a screenshot; nothing is ever evaluated.

export const NS = "see-inspect" as const;
export const PROTO = 1 as const;

// Hardcoded allowlist. Even if a page announces extra capabilities, the parent only ever
// surfaces the ones in this set (see `grantCapabilities`).
export const PARENT_ALLOWED_CAPABILITIES = ["inspect"] as const;
export type Capability = (typeof PARENT_ALLOWED_CAPABILITIES)[number];

export type TargetRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InspectTarget = {
  seeId: string;
  seeLabel: string;
  rect: TargetRect;
};

// page -> parent
export type HelloMessage = {
  ns: typeof NS;
  proto: typeof PROTO;
  type: "hello";
  capabilities: string[];
  sdkVersion: string;
  pageUrl: string;
};

export type TargetsMessage = {
  ns: typeof NS;
  proto: typeof PROTO;
  type: "targets";
  targets: InspectTarget[];
};

export type ByeMessage = {
  ns: typeof NS;
  proto: typeof PROTO;
  type: "bye";
};

// parent -> page
export type AckMessage = {
  ns: typeof NS;
  proto: typeof PROTO;
  type: "ack";
  capabilities: Capability[];
};

export type InspectToggleMessage = {
  ns: typeof NS;
  proto: typeof PROTO;
  type: "inspect-enable" | "inspect-disable";
};

export type PageMessage = HelloMessage | TargetsMessage | ByeMessage;
export type ParentMessage = AckMessage | InspectToggleMessage;

// Cheap pre-validation gate applied before any origin/identity checks.
export function isSeeMessage(data: unknown): data is { ns: typeof NS; proto: typeof PROTO; type: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { ns?: unknown }).ns === NS &&
    (data as { proto?: unknown }).proto === PROTO &&
    typeof (data as { type?: unknown }).type === "string"
  );
}

export function isHelloMessage(data: { type: string }): data is HelloMessage {
  return data.type === "hello" && Array.isArray((data as HelloMessage).capabilities);
}

export function isTargetsMessage(data: { type: string }): data is TargetsMessage {
  return data.type === "targets" && Array.isArray((data as TargetsMessage).targets);
}

// Intersect an announced capability list with the parent allowlist. The result is the only
// set of tools the bar will ever surface, regardless of what the page claims.
export function grantCapabilities(announced: string[]): Capability[] {
  const allowed = new Set<string>(PARENT_ALLOWED_CAPABILITIES);
  const granted: Capability[] = [];
  for (const capability of announced) {
    if (allowed.has(capability) && !granted.includes(capability as Capability)) {
      granted.push(capability as Capability);
    }
  }
  return granted;
}

// Validate and normalize an untrusted target list from the page. Drops anything malformed so
// the overlay only ever renders finite, sane rectangles.
export function sanitizeTargets(value: unknown): InspectTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const targets: InspectTarget[] = [];
  for (let index = 0; index < value.length && targets.length < 200; index += 1) {
    const raw = value[index] as Partial<InspectTarget> | null;
    const rect = raw?.rect as Partial<TargetRect> | undefined;
    if (!rect || !isFiniteNumber(rect.x) || !isFiniteNumber(rect.y) || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) {
      continue;
    }
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    targets.push({
      seeId: typeof raw?.seeId === "string" ? raw.seeId.slice(0, 200) : `target-${index}`,
      seeLabel: typeof raw?.seeLabel === "string" ? raw.seeLabel.slice(0, 200) : "",
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }
  return targets;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
