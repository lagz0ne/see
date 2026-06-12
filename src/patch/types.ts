// Structured, content-type-aware patching ("agent-browser" style).
//
// An LLM (or human) addresses nodes with the query language native to the file
// type — CSS selectors for HTML, JSON Pointer for JSON, selector+property for
// CSS — and applies a small mutation. Many ops batch into one request, are
// applied atomically (all-or-nothing), and bump the revision once.

/** Result for a single op, returned in the same order ops were submitted. */
export type OpResult = {
  /** Number of nodes/targets the address matched. */
  matched: number;
  /** Whether the op mutated the document (false for no-match or dry runs). */
  applied: boolean;
  /** Present when the op was rejected (bad address/action/value). */
  error?: string;
};

/** What one applier returns for a single file. */
export type ApplyResult = {
  /** Serialized file contents after applying every op. */
  output: string;
  /** One result per input op, in order. */
  results: OpResult[];
  /** True if any op changed the document. */
  changed: boolean;
};

// ── HTML ops (addressed by CSS selector; applies to every match) ────────────
export type HtmlOp =
  | { select: string; action: "setText"; value: string }
  | { select: string; action: "setHtml"; value: string }
  | { select: string; action: "setAttr"; name: string; value: string }
  | { select: string; action: "removeAttr"; name: string }
  | { select: string; action: "addClass"; value: string }
  | { select: string; action: "removeClass"; value: string }
  | { select: string; action: "replaceWith"; value: string }
  | { select: string; action: "append"; value: string }
  | { select: string; action: "prepend"; value: string }
  | { select: string; action: "remove" };

// ── JSON ops (addressed by RFC 6901 JSON Pointer) ───────────────────────────
export type JsonOp =
  // set = replace if present, create if the parent exists (add semantics)
  | { pointer: string; action: "set"; value: unknown }
  | { pointer: string; action: "remove" }
  // insert into an array at the pointer's final index (shifts the rest)
  | { pointer: string; action: "insert"; value: unknown }
  // append to the array addressed by pointer
  | { pointer: string; action: "append"; value: unknown };

// ── CSS ops (addressed by rule selector + declaration property) ─────────────
export type CssOp =
  | { selectRule: string; action: "setDecl"; prop: string; value: string }
  | { selectRule: string; action: "removeDecl"; prop: string }
  | { selectRule: string; action: "removeRule" }
  | { action: "addRule"; selector: string; declarations: Record<string, string> };

export type PatchKind = "html" | "json" | "css";

/** A raw op as received in the request body, before per-kind validation. */
export type RawOp = Record<string, unknown> & { file?: unknown };
