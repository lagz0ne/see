import type { ApplyResult, JsonOp, OpResult } from "./types";

// Apply JSON Pointer (RFC 6901) addressed mutations to a JSON document. A
// pointer addresses exactly one location, so `matched` is 0 or 1. Indentation
// is sniffed from the source so re-serialized files stay diff-friendly.
export function applyJsonOps(source: string, ops: JsonOp[]): ApplyResult {
  let root: unknown;
  try {
    root = JSON.parse(source);
  } catch (error) {
    // Whole file unparseable → every op fails, document untouched.
    const message = `file is not valid JSON: ${errorMessage(error)}`;
    return { output: source, results: ops.map(() => ({ matched: 0, applied: false, error: message })), changed: false };
  }

  const indent = sniffIndent(source);
  const results: OpResult[] = [];
  let changed = false;

  for (const op of ops) {
    try {
      const outcome = applyOne(root, op);
      if (outcome.newRoot !== undefined) root = outcome.newRoot;
      if (outcome.applied) changed = true;
      results.push({ matched: outcome.matched, applied: outcome.applied });
    } catch (error) {
      results.push({ matched: 0, applied: false, error: errorMessage(error) });
    }
  }

  const output = changed ? JSON.stringify(root, null, indent) + trailingNewline(source) : source;
  return { output, results, changed };
}

type Outcome = { matched: number; applied: boolean; newRoot?: unknown };

function applyOne(root: unknown, op: JsonOp): Outcome {
  const tokens = parsePointer(op.pointer);

  if (op.action === "set" && tokens.length === 0) {
    return { matched: 1, applied: true, newRoot: op.value };
  }
  if (tokens.length === 0) {
    throw new Error(`action "${op.action}" cannot target the document root`);
  }

  const key = tokens[tokens.length - 1]!;
  const parent = navigate(root, tokens.slice(0, -1));
  if (parent === undefined || parent === null || typeof parent !== "object") {
    return { matched: 0, applied: false };
  }

  if (op.action === "append") {
    const target = navigate(root, tokens);
    if (!Array.isArray(target)) throw new Error(`pointer "${op.pointer}" does not address an array`);
    target.push(op.value);
    return { matched: 1, applied: true };
  }

  if (Array.isArray(parent)) {
    if (op.action === "set") {
      const i = key === "-" ? parent.length : arrayIndex(key, parent.length, true);
      parent[i] = op.value;
      return { matched: 1, applied: true };
    }
    if (op.action === "insert") {
      const i = key === "-" ? parent.length : arrayIndex(key, parent.length, true);
      parent.splice(i, 0, op.value);
      return { matched: 1, applied: true };
    }
    // remove
    const i = arrayIndex(key, parent.length, false);
    if (i < 0 || i >= parent.length) return { matched: 0, applied: false };
    parent.splice(i, 1);
    return { matched: 1, applied: true };
  }

  // object parent
  const obj = parent as Record<string, unknown>;
  if (op.action === "insert") throw new Error(`"insert" requires an array parent at "${op.pointer}"`);
  if (op.action === "set") {
    obj[key] = op.value;
    return { matched: 1, applied: true };
  }
  // remove
  if (!(key in obj)) return { matched: 0, applied: false };
  delete obj[key];
  return { matched: 1, applied: true };
}

function navigate(root: unknown, tokens: string[]): unknown {
  let current = root;
  for (const token of tokens) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const i = arrayIndex(token, current.length, false);
      if (i < 0 || i >= current.length) return undefined;
      current = current[i];
    } else {
      const obj = current as Record<string, unknown>;
      if (!(token in obj)) return undefined;
      current = obj[token];
    }
  }
  return current;
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number {
  if (token === "-") return allowEnd ? length : -1;
  if (!/^\d+$/.test(token)) throw new Error(`"${token}" is not a valid array index`);
  return Number(token);
}

function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`pointer must be empty or start with "/": "${pointer}"`);
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function sniffIndent(source: string): string | number {
  const match = source.match(/\n([ \t]+)\S/);
  if (!match) return 2;
  return match[1]!.includes("\t") ? "\t" : match[1]!.length;
}

function trailingNewline(source: string): string {
  return source.endsWith("\n") ? "\n" : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
