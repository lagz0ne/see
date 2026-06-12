import { parseHTML } from "linkedom";
import type { ApplyResult, HtmlOp, OpResult } from "./types";

// Apply CSS-selector-addressed mutations to an HTML document. A selector that
// matches N elements applies the op to all N. Untouched markup is preserved as
// closely as the parser allows (linkedom keeps original formatting of nodes it
// never visits). Each op is isolated: a bad selector or action fails only that
// op and is reported in `results[i].error`.
export function applyHtmlOps(source: string, ops: HtmlOp[]): ApplyResult {
  const { document } = parseHTML(source);
  const results: OpResult[] = [];
  let changed = false;

  for (const op of ops) {
    try {
      const nodes = Array.from(document.querySelectorAll(op.select)) as any[];
      if (nodes.length === 0) {
        results.push({ matched: 0, applied: false });
        continue;
      }
      for (const el of nodes) {
        applyToElement(el, op);
      }
      changed = true;
      results.push({ matched: nodes.length, applied: true });
    } catch (error) {
      results.push({ matched: 0, applied: false, error: errorMessage(error) });
    }
  }

  return { output: changed ? document.toString() : source, results, changed };
}

function applyToElement(el: any, op: HtmlOp): void {
  switch (op.action) {
    case "setText":
      el.textContent = op.value;
      return;
    case "setHtml":
      el.innerHTML = op.value;
      return;
    case "setAttr":
      el.setAttribute(op.name, op.value);
      return;
    case "removeAttr":
      el.removeAttribute(op.name);
      return;
    case "addClass":
      for (const cls of op.value.split(/\s+/).filter(Boolean)) el.classList.add(cls);
      return;
    case "removeClass":
      for (const cls of op.value.split(/\s+/).filter(Boolean)) el.classList.remove(cls);
      return;
    case "replaceWith":
      el.insertAdjacentHTML("beforebegin", op.value);
      el.remove();
      return;
    case "append":
      el.insertAdjacentHTML("beforeend", op.value);
      return;
    case "prepend":
      el.insertAdjacentHTML("afterbegin", op.value);
      return;
    case "remove":
      el.remove();
      return;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
