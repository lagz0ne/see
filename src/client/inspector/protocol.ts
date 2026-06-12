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

// The capabilities the bar knows how to ask about and render. A page can announce extras, but
// the parent only ever surfaces the ones in this set (see `grantCapabilities`) — this list IS
// the allowlist. Handshake is bidirectional: the page posts `hello` when its SDK loads, and the
// bar posts `hello-request` when it (re)mounts, to which the page replies `hello`. A reply means
// "matched"; absence is treated as "not present" without guessing via timeouts.
export const PARENT_ALLOWED_CAPABILITIES = ["inspect", "tweaks"] as const;
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

// A live design control the page exposes (Claude Design "Tweaks"). The bar renders a control of
// the given kind and posts `tweak-set` back when the user changes it.
export type TweakKind = "color" | "number" | "toggle" | "select" | "text";
export type TweakValue = string | number | boolean;

export type TweakDef = {
  id: string;
  label: string;
  kind: TweakKind;
  value: TweakValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: string[];
  group?: string;
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

export type TweaksMessage = {
  ns: typeof NS;
  proto: typeof PROTO;
  type: "tweaks";
  tweaks: TweakDef[];
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

// Probe sent by the bar on (re)mount; the page replies with `hello` (and, if it has tweaks, a
// `tweaks` message). Covers the race where the bar mounts after the page already loaded.
export type HelloRequestMessage = {
  ns: typeof NS;
  proto: typeof PROTO;
  type: "hello-request";
};

export type InspectToggleMessage = {
  ns: typeof NS;
  proto: typeof PROTO;
  type: "inspect-enable" | "inspect-disable";
};

export type TweakSetMessage = {
  ns: typeof NS;
  proto: typeof PROTO;
  type: "tweak-set";
  id: string;
  value: TweakValue;
};

export type PageMessage = HelloMessage | TargetsMessage | TweaksMessage | ByeMessage;
export type ParentMessage = AckMessage | HelloRequestMessage | InspectToggleMessage | TweakSetMessage;

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

export function isTweaksMessage(data: { type: string }): data is TweaksMessage {
  return data.type === "tweaks" && Array.isArray((data as TweaksMessage).tweaks);
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

// Validate and normalize an untrusted tweak schema from the page. Drops malformed entries and
// clamps strings so the bar only renders well-formed controls. Infers/repairs the kind from the
// value type when the declared kind is missing or inconsistent.
export function sanitizeTweaks(value: unknown): TweakDef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tweaks: TweakDef[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length && tweaks.length < 100; index += 1) {
    const raw = value[index] as Partial<TweakDef> | null;
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id.slice(0, 120) : "";
    if (!id || seen.has(id)) {
      continue;
    }
    const value_ = raw.value;
    if (typeof value_ !== "string" && typeof value_ !== "number" && typeof value_ !== "boolean") {
      continue;
    }
    seen.add(id);
    const kind = normalizeTweakKind(raw.kind, value_);
    const options = Array.isArray(raw.options)
      ? raw.options.filter((option): option is string => typeof option === "string").slice(0, 64)
      : undefined;
    tweaks.push({
      id,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.slice(0, 120) : id,
      kind,
      value: value_,
      min: isFiniteNumber(raw.min) ? raw.min : undefined,
      max: isFiniteNumber(raw.max) ? raw.max : undefined,
      step: isFiniteNumber(raw.step) ? raw.step : undefined,
      unit: typeof raw.unit === "string" ? raw.unit.slice(0, 16) : undefined,
      options: kind === "select" ? options : undefined,
      group: typeof raw.group === "string" ? raw.group.slice(0, 60) : undefined,
    });
  }
  return tweaks;
}

function normalizeTweakKind(kind: unknown, value: TweakValue): TweakKind {
  const known: TweakKind[] = ["color", "number", "toggle", "select", "text"];
  if (typeof kind === "string" && (known as string[]).includes(kind)) {
    return kind as TweakKind;
  }
  if (typeof value === "boolean") {
    return "toggle";
  }
  if (typeof value === "number") {
    return "number";
  }
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? "color" : "text";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
