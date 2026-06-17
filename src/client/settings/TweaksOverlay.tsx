import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// Mirrors the GET /api/uploads/:id/tweaks payload (see src/app.ts resolveBundleTweaks).
type ResolvedTweak = {
  id: string;
  kind?: string;
  label?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  cssVar?: string;
  options?: string[];
  value: string | number | boolean | null;
  valueSource: "page" | "shared" | null;
};

// Mirrors GET /api/uploads/:id/tweaks/discover (a token found in the bundle's CSS, plus whether it
// is already exposed as a tweak).
type DiscoveredCandidate = {
  id: string;
  cssVar: string;
  kind: "color" | "number" | "text";
  value: string | number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  group: string;
  exposed: boolean;
};

type ControlValue = string | number | boolean;

// localStorage map is cssVar -> the FORMATTED css string the runtime applies verbatim (e.g. "20px",
// "1", "#0A84FF"). Keeping the runtime currency here means see:state can be replayed as-is on every
// page handshake.
type Overrides = Record<string, string>;

const STORE_PREFIX = "see.tweaks.";
// Mirrors the server's per-set tweak cap (src/bundle.ts) — exposing must not exceed it or the patch
// is rejected as invalid_manifest.
const MANIFEST_TWEAK_LIMIT = 100;

function readOverrides(key: string): Overrides {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Overrides = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeOverrides(key: string, value: Overrides): void {
  try {
    if (Object.keys(value).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or disabled storage — preview still works for the session; nothing else to do.
  }
}

// The css string the static injector would emit for this control value, so live preview matches the
// served output: booleans -> "1"/"0", numbers carry the unit, everything else is the raw string.
function formatCssValue(def: ResolvedTweak, value: ControlValue): string {
  if (def.kind === "toggle" || typeof value === "boolean") return value ? "1" : "0";
  const unit = def.unit && typeof value === "number" ? def.unit : "";
  return `${value}${unit}`;
}

// The native color picker only accepts #rrggbb. Expand #rgb shorthand so e.g. "#fff" shows white;
// non-hex values (named / rgb() / oklch) can't be represented by the swatch, so it falls back while
// the text field stays the source of truth.
function toPickerHex(value: string): string {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return "#000000";
}

// Parse a stored css string back into a control value, using the def's kind to pick the shape.
function parseControlValue(def: ResolvedTweak, formatted: string): ControlValue {
  if (def.kind === "toggle") return formatted === "1" || formatted === "true";
  if (def.kind === "number") {
    const n = parseFloat(formatted);
    return Number.isFinite(n) ? n : 0;
  }
  return formatted;
}

// The viewer-side half of the see:* bridge. The content iframe is storage-less and opaque-origin, so
// the VIEWER (concrete origin) owns all state + its lifecycle: it answers the iframe's see:hello with
// a MessagePort, replays see:state on every page handshake (cross-page persistence), and drives
// live see:tweak/see:reset/see:clear. State lives in viewer-origin localStorage, namespaced by share.
export function useTweakBridge(uploadId: string, iframeRef: RefObject<HTMLIFrameElement | null>) {
  const storageKey = `${STORE_PREFIX}${uploadId}`;
  const [overrides, setOverrides] = useState<Overrides>(() => readOverrides(storageKey));
  const [runtimePath, setRuntimePath] = useState<string | null>(null);
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const portRef = useRef<MessagePort | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const iframe = iframeRef.current;
      // Identify our sandboxed child by source (its origin is opaque, so it can't be origin-matched).
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as { type?: string; id?: string; path?: string } | null;
      // The id check filters cross-share / accidental messages, but it is NOT a security boundary:
      // uploaded JS shares this opaque origin + contentWindow and knows the share id, so it can spoof
      // see:hello (no in-document handshake can be unspoofable — any nonce the runtime can read, page
      // code can read too). That is acceptable because the bridge is one-way (viewer -> content) and
      // carries only cosmetic cssVar overrides the content already sees applied to its own :root —
      // there is no viewer-private data to leak, and we never act on inbound messages from the port.
      if (!data || data.type !== "see:hello" || data.id !== uploadId) return;
      const port = event.ports[0];
      if (!port) return;
      portRef.current = port;
      // Track the iframe's actual page (it re-announces on every navigation) so the overlay shows
      // the page that is actually being previewed, not a stale viewer-selector value.
      if (typeof data.path === "string") setRuntimePath(data.path);
      // Replay the visitor's overrides so the freshly loaded page reflects them before they interact.
      port.postMessage({ type: "see:state", vars: overridesRef.current });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef, uploadId]);

  const persist = useCallback(
    (next: Overrides) => {
      setOverrides(next);
      writeOverrides(storageKey, next);
    },
    [storageKey],
  );

  const setTweak = useCallback(
    (cssVar: string, cssValue: string) => {
      portRef.current?.postMessage({ type: "see:tweak", cssVar, value: cssValue });
      persist({ ...overridesRef.current, [cssVar]: cssValue });
    },
    [persist],
  );

  const resetTweak = useCallback(
    (cssVar: string) => {
      portRef.current?.postMessage({ type: "see:reset", cssVar });
      const next = { ...overridesRef.current };
      delete next[cssVar];
      persist(next);
    },
    [persist],
  );

  const clearAll = useCallback(() => {
    const keys = Object.keys(overridesRef.current);
    if (keys.length > 0) portRef.current?.postMessage({ type: "see:clear", cssVars: keys });
    persist({});
  }, [persist]);

  return { overrides, setTweak, resetTweak, clearAll, runtimePath };
}

type Bridge = ReturnType<typeof useTweakBridge>;

export function TweaksOverlay({
  uploadId,
  page,
  revision,
  bridge,
  onClose,
}: {
  uploadId: string;
  page: string | null;
  revision: number;
  bridge: Bridge;
  onClose: () => void;
}) {
  const [tweaks, setTweaks] = useState<ResolvedTweak[] | null>(null);
  const [candidates, setCandidates] = useState<DiscoveredCandidate[]>([]);
  const [sharedCount, setSharedCount] = useState(0);
  const [discoverRevision, setDiscoverRevision] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const { overrides, setTweak, resetTweak, clearAll } = bridge;

  useEffect(() => {
    let cancelled = false;
    const query = page ? `?page=${encodeURIComponent(page)}` : "";
    fetch(`/api/uploads/${uploadId}/tweaks${query}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { tweaks: [] }))
      .then((d) => {
        if (!cancelled) setTweaks(Array.isArray(d.tweaks) ? d.tweaks : []);
      })
      .catch(() => {
        if (!cancelled) setTweaks([]);
      });
    return () => {
      cancelled = true;
    };
    // revision/refreshNonce in the key: a see.json patch (which bumps revision) or a local Expose
    // refetches the resolved defs.
  }, [uploadId, page, revision, refreshNonce]);

  // Discovery candidates (share-wide): tokens found in the CSS, flagged whether already exposed.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/uploads/${uploadId}/tweaks/discover`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { candidates: [], sharedCount: 0 }))
      .then((d) => {
        if (cancelled) return;
        setCandidates(Array.isArray(d.candidates) ? d.candidates : []);
        setSharedCount(typeof d.sharedCount === "number" ? d.sharedCount : 0);
        setDiscoverRevision(typeof d.revision === "number" ? d.revision : 0);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [uploadId, revision, refreshNonce]);

  // Only tweaks with a cssVar are drivable by the runtime; group them for a spec-sheet layout.
  const groups = useMemo(() => {
    const drivable = (tweaks ?? []).filter((t) => t.cssVar && t.cssVar.length > 0);
    const byGroup = new Map<string, ResolvedTweak[]>();
    for (const t of drivable) {
      const g = t.group ?? "";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(t);
    }
    return [...byGroup.entries()];
  }, [tweaks]);

  const dirtyCount = Object.keys(overrides).length;
  // Memoized so its reference is stable across unrelated overlay re-renders (e.g. an override change) —
  // otherwise DiscoverSection re-seeds its selection and re-checks tokens the user just unchecked.
  const newCandidates = useMemo(() => candidates.filter((c) => !c.exposed), [candidates]);

  return (
    <aside className="pointer-events-auto fixed top-20 right-3 bottom-3 z-40 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border bg-card text-card-foreground">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex flex-col">
          <span className="font-mono text-[0.65rem] tracking-[0.12em] text-muted-foreground uppercase">Tweaks</span>
          {page ? <span className="truncate font-mono text-xs text-muted-foreground">{page}</span> : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close tweaks">
          <X />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
        {tweaks === null ? (
          <p className="font-mono text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            {groups.map(([group, items]) => (
              <section key={group} className="flex flex-col gap-3">
                {group ? (
                  <h3 className="font-mono text-[0.65rem] tracking-[0.12em] text-muted-foreground uppercase">{group}</h3>
                ) : null}
                {items.map((tweak) => (
                  <TweakRow
                    key={tweak.id}
                    tweak={tweak}
                    override={tweak.cssVar ? overrides[tweak.cssVar] : undefined}
                    onChange={(value) => tweak.cssVar && setTweak(tweak.cssVar, formatCssValue(tweak, value))}
                    onReset={() => tweak.cssVar && resetTweak(tweak.cssVar)}
                  />
                ))}
              </section>
            ))}
            <DiscoverSection
              candidates={newCandidates}
              uploadId={uploadId}
              capacity={Math.max(0, MANIFEST_TWEAK_LIMIT - sharedCount)}
              discoverRevision={discoverRevision}
              onExposed={() => setRefreshNonce((n) => n + 1)}
            />
            {groups.length === 0 && newCandidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No design tokens exposed, and none found in this share's CSS. Add{" "}
                <span className="font-mono">tweaks</span> with a <span className="font-mono">cssVar</span> to{" "}
                <span className="font-mono">see.json</span>.
              </p>
            ) : null}
          </>
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {dirtyCount > 0 ? `${dirtyCount} changed · this browser` : "Published defaults"}
        </span>
        <Button variant="outline" size="sm" onClick={clearAll} disabled={dirtyCount === 0}>
          <Trash2 data-icon="inline-start" />
          Clear
        </Button>
      </footer>
    </aside>
  );
}

function TweakRow({
  tweak,
  override,
  onChange,
  onReset,
}: {
  tweak: ResolvedTweak;
  override: string | undefined;
  onChange: (value: ControlValue) => void;
  onReset: () => void;
}) {
  // Effective control value: the visitor's local override (parsed) if present, else the resolved value.
  const value: ControlValue =
    override !== undefined ? parseControlValue(tweak, override) : tweak.value ?? defaultForKind(tweak);
  const overridden = override !== undefined;
  const label = tweak.label ?? tweak.id;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Label htmlFor={`tweak-${tweak.id}`} className="truncate">
            {label}
          </Label>
          <Dot overridden={overridden} pageOverride={tweak.valueSource === "page"} />
        </div>
        {overridden ? (
          <Button variant="ghost" size="icon-sm" onClick={onReset} aria-label={`Reset ${label}`}>
            <RotateCcw />
          </Button>
        ) : null}
      </div>
      <TweakControl tweak={tweak} value={value} onChange={onChange} />
      {tweak.cssVar ? (
        <span className="truncate font-mono text-[0.65rem] text-muted-foreground">{tweak.cssVar}</span>
      ) : null}
    </div>
  );
}

// A filled dot when this page overrides the value (or the visitor has), a hollow one when inherited.
function Dot({ overridden, pageOverride }: { overridden: boolean; pageOverride: boolean }) {
  const filled = overridden || pageOverride;
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", filled ? "bg-primary" : "border border-muted-foreground/50")}
    />
  );
}

function TweakControl({
  tweak,
  value,
  onChange,
}: {
  tweak: ResolvedTweak;
  value: ControlValue;
  onChange: (value: ControlValue) => void;
}) {
  const id = `tweak-${tweak.id}`;
  const kind = tweak.kind ?? inferKind(value);

  if (kind === "toggle") {
    return <Switch id={id} checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked)} />;
  }

  // Radix SelectItem throws on an empty value; the manifest may declare "" options, so drop them
  // (and fall through to a text input if nothing usable remains).
  const options = (tweak.options ?? []).filter((option) => option.length > 0);
  if (kind === "select" && options.length > 0) {
    return (
      <Select value={String(value)} onValueChange={(v) => onChange(v)}>
        <SelectTrigger id={id} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (kind === "number") {
    const min = tweak.min ?? 0;
    const max = tweak.max ?? 100;
    const step = tweak.step ?? 1;
    const parsed = typeof value === "number" ? value : parseFloat(String(value));
    const numeric = Number.isFinite(parsed) ? parsed : min;
    return (
      <div className="flex items-center gap-3">
        <Slider
          id={id}
          value={[numeric]}
          min={min}
          max={max}
          step={step}
          onValueChange={(values) => onChange(values[0] ?? numeric)}
          className="flex-1"
        />
        <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums">
          {numeric}
          {tweak.unit ?? ""}
        </span>
      </div>
    );
  }

  if (kind === "color") {
    const hex = String(value);
    // Only 3/6-digit hex is picker-supported; alpha hex (#rgba / #rrggbbaa) uses the swatch + text.
    const hexLike = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.trim());
    return (
      <div className="flex items-center gap-2">
        {hexLike ? (
          <input
            id={id}
            type="color"
            value={toPickerHex(hex)}
            onChange={(e) => onChange(e.target.value)}
            className="size-8 shrink-0 cursor-pointer rounded-md border bg-transparent"
            aria-label={`${tweak.label ?? tweak.id} color`}
          />
        ) : (
          // Non-hex (oklch/rgb/named): a read-only swatch shows the real color (the native picker only
          // does #rrggbb and would clobber the value to black on touch); the text field stays the editor.
          <span aria-hidden className="size-8 shrink-0 rounded-md border" style={{ background: hex }} />
        )}
        <Input
          id={hexLike ? undefined : id}
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-xs"
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <Input
      id={id}
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
      className="font-mono text-xs"
      spellCheck={false}
    />
  );
}

function inferKind(value: ControlValue): string {
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number") return "number";
  if (typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value)) return "color";
  return "text";
}

function defaultForKind(tweak: ResolvedTweak): ControlValue {
  switch (tweak.kind) {
    case "toggle":
      return false;
    case "number":
      return tweak.min ?? 0;
    case "color":
      return "#000000";
    case "select":
      return tweak.options?.find((option) => option.length > 0) ?? "";
    default:
      return "";
  }
}

// The see.json tweak object for a discovered candidate (keeps the def fields, drops id/exposed).
function manifestTweakOf(c: DiscoveredCandidate): Record<string, unknown> {
  const tweak: Record<string, unknown> = {
    kind: c.kind,
    value: c.value,
    cssVar: c.cssVar,
    label: c.label,
    group: c.group,
  };
  if (c.unit) tweak.unit = c.unit;
  if (c.kind === "number") {
    if (typeof c.min === "number") tweak.min = c.min;
    if (typeof c.max === "number") tweak.max = c.max;
    if (typeof c.step === "number") tweak.step = c.step;
  }
  return tweak;
}

// The "we found your design tokens" offload: lists CSS tokens not yet exposed and one-click writes
// the chosen ones into see.json via the patch API. Auth: open shares need no token; password shares
// reveal an edit-token field on a 401.
function DiscoverSection({
  candidates,
  uploadId,
  capacity,
  discoverRevision,
  onExposed,
}: {
  candidates: DiscoveredCandidate[];
  uploadId: string;
  capacity: number;
  discoverRevision: number;
  onExposed: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.slice(0, capacity).map((c) => c.id)));
  const [token, setToken] = useState("");
  const [needsToken, setNeedsToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the candidate set or capacity changes — capped at the remaining manifest capacity so
  // the default one-click Expose can't exceed the tweak limit and get rejected.
  useEffect(() => {
    setSelected(new Set(candidates.slice(0, capacity).map((c) => c.id)));
  }, [candidates, capacity]);

  if (candidates.length === 0) return null;

  const chosen = candidates.filter((c) => selected.has(c.id));
  const overCapacity = chosen.length > capacity;

  async function expose() {
    if (chosen.length === 0 || overCapacity) return;
    setBusy(true);
    setError(null);
    // The server resolves each id's uniqueness at write time, so a second editor can't clobber.
    const tweaks = chosen.map((c) => ({ id: c.id, ...manifestTweakOf(c) }));
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
      const res = await fetch(`/api/uploads/${uploadId}/tweaks/expose`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: discoverRevision, tweaks }),
      });
      if (res.status === 401) {
        setNeedsToken(true);
        setError("This share needs an edit token to expose tokens.");
      } else if (res.status === 409) {
        setError("Tokens changed since you opened this — refreshed, try again.");
        onExposed();
      } else if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || "Couldn't expose those tokens.");
      } else {
        const body = await res.json().catch(() => null);
        const exposed = Array.isArray(body?.exposed) ? body.exposed : [];
        if (exposed.length === 0) setError("Those tokens are already exposed.");
        onExposed(); // refresh either way so the panel reflects the current manifest
      }
    } catch {
      setError("Couldn't expose those tokens.");
    }
    setBusy(false);
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-dashed px-3 py-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-mono text-[0.65rem] tracking-[0.12em] text-muted-foreground uppercase">From your CSS</h3>
        <p className="text-sm">
          Found <span className="font-mono tabular-nums">{candidates.length}</span> token
          {candidates.length === 1 ? "" : "s"} not yet exposed.
        </p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {candidates.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <Checkbox
              id={`disc-${c.id}`}
              checked={selected.has(c.id)}
              onCheckedChange={(value) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (value) next.add(c.id);
                  else next.delete(c.id);
                  return next;
                })
              }
            />
            <Label htmlFor={`disc-${c.id}`} className="flex min-w-0 flex-1 items-center justify-between gap-2 font-normal">
              <span className="truncate">{c.label}</span>
              <span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">{c.cssVar}</span>
            </Label>
          </li>
        ))}
      </ul>
      {capacity === 0 ? (
        <p className="text-xs text-muted-foreground">Tweak limit reached — remove some before exposing more.</p>
      ) : overCapacity ? (
        <p className="text-xs text-destructive">Select at most {capacity} (the manifest tweak limit).</p>
      ) : null}
      {needsToken ? (
        <Input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Edit token"
          className="font-mono text-xs"
          spellCheck={false}
        />
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button size="sm" onClick={expose} disabled={busy || chosen.length === 0 || overCapacity || capacity === 0}>
        Expose{chosen.length > 0 ? ` ${chosen.length}` : ""}
      </Button>
    </section>
  );
}
