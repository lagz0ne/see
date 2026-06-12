import { applyCssOps } from "./css";
import { applyHtmlOps } from "./html";
import { applyJsonOps } from "./json";
import type { CssOp, HtmlOp, JsonOp, OpResult, PatchKind, RawOp } from "./types";

export const MAX_OPS_PER_BATCH = 200;

export type BatchOpResult = OpResult & { file: string };

export type PatchBatchResult = {
  /** One result per submitted op, in order. */
  results: BatchOpResult[];
  /** Changed file contents to persist (only populated when ok). */
  outputs: Map<string, string>;
  /** True when no op errored — the endpoint persists outputs only then. */
  ok: boolean;
};

const HTML_ACTIONS = new Set([
  "setText", "setHtml", "setAttr", "removeAttr", "addClass", "removeClass", "replaceWith", "append", "prepend", "remove",
]);
const JSON_ACTIONS = new Set(["set", "remove", "insert", "append"]);
const CSS_ACTIONS = new Set(["setDecl", "removeDecl", "removeRule", "addRule"]);

type Validated = { kind: PatchKind; op: HtmlOp | JsonOp | CssOp };

/**
 * Validate + apply a batch of structured patch ops. Pure aside from the
 * injected `readFile`. Computes every file's new contents in memory; the
 * caller persists `outputs` atomically only when `ok` is true.
 */
export async function applyPatchBatch(
  rawOps: RawOp[],
  readFile: (file: string) => Promise<string | null>,
): Promise<PatchBatchResult> {
  // Validate shape up front; collect per-op kind/file or an error result.
  type Slot = { file: string; kind: PatchKind; op: HtmlOp | JsonOp | CssOp } | { file: string; error: string };
  const slots: Slot[] = rawOps.map((raw) => {
    const file = typeof raw.file === "string" ? raw.file.trim() : "";
    if (!file) return { file: "", error: "op is missing a \"file\"" };
    const kind = kindForFile(file);
    if (!kind) return { file, error: `unsupported file type for patching: ${file}` };
    try {
      const { op } = validateOp(kind, raw);
      return { file, kind, op };
    } catch (error) {
      return { file, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Group valid ops by file, remembering original index for stable results.
  const byFile = new Map<string, { index: number; kind: PatchKind; op: HtmlOp | JsonOp | CssOp }[]>();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if ("error" in slot) continue;
    const group = byFile.get(slot.file) ?? [];
    group.push({ index: i, kind: slot.kind, op: slot.op });
    byFile.set(slot.file, group);
  }

  const results: BatchOpResult[] = slots.map((slot) =>
    "error" in slot ? { file: slot.file, matched: 0, applied: false, error: slot.error } : { file: slot.file, matched: 0, applied: false },
  );
  const outputs = new Map<string, string>();

  for (const [file, group] of byFile) {
    const source = await readFile(file);
    if (source === null) {
      for (const { index } of group) results[index] = { file, matched: 0, applied: false, error: `file not found: ${file}` };
      continue;
    }
    const kind = group[0]!.kind;
    const ops = group.map((g) => g.op);
    const applied = runApplier(kind, source, ops);
    applied.results.forEach((r, j) => {
      results[group[j]!.index] = { file, ...r };
    });
    if (applied.changed) outputs.set(file, applied.output);
  }

  const ok = results.every((r) => !r.error);
  if (!ok) outputs.clear();
  return { results, outputs, ok };
}

function runApplier(kind: PatchKind, source: string, ops: (HtmlOp | JsonOp | CssOp)[]) {
  if (kind === "html") return applyHtmlOps(source, ops as HtmlOp[]);
  if (kind === "json") return applyJsonOps(source, ops as JsonOp[]);
  return applyCssOps(source, ops as CssOp[]);
}

function kindForFile(file: string): PatchKind | null {
  const lower = file.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  return null;
}

function validateOp(kind: PatchKind, raw: RawOp): Validated {
  const action = typeof raw.action === "string" ? raw.action : "";
  if (kind === "html") {
    if (!HTML_ACTIONS.has(action)) throw new Error(`action "${action}" is not valid for html`);
    requireString(raw, "select");
    if (action === "setAttr") { requireString(raw, "name"); requireString(raw, "value"); }
    if (action === "removeAttr") requireString(raw, "name");
    if (["setText", "setHtml", "addClass", "removeClass", "replaceWith", "append", "prepend"].includes(action))
      requireString(raw, "value");
    return { kind, op: raw as unknown as HtmlOp };
  }
  if (kind === "json") {
    if (!JSON_ACTIONS.has(action)) throw new Error(`action "${action}" is not valid for json`);
    if (typeof raw.pointer !== "string") throw new Error(`json op requires a string "pointer"`);
    if ((action === "set" || action === "insert" || action === "append") && !("value" in raw))
      throw new Error(`action "${action}" requires a "value"`);
    return { kind, op: raw as unknown as JsonOp };
  }
  // css
  if (!CSS_ACTIONS.has(action)) throw new Error(`action "${action}" is not valid for css`);
  if (action === "addRule") {
    requireString(raw, "selector");
    if (!raw.declarations || typeof raw.declarations !== "object" || Array.isArray(raw.declarations))
      throw new Error(`"addRule" requires a "declarations" object`);
  } else {
    requireString(raw, "selectRule");
    if (action === "setDecl") { requireString(raw, "prop"); requireString(raw, "value"); }
    if (action === "removeDecl") requireString(raw, "prop");
  }
  return { kind, op: raw as unknown as CssOp };
}

function requireString(raw: RawOp, field: string): void {
  if (typeof raw[field] !== "string" || (raw[field] as string).length === 0)
    throw new Error(`op requires a non-empty string "${field}"`);
}
