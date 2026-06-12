import postcss from "postcss";
import type { ApplyResult, CssOp, OpResult } from "./types";

// Apply selector-addressed mutations to a stylesheet. Rules are matched by
// their (whitespace-normalized) selector text; a selector matching N rules
// applies the op to all N. PostCSS preserves formatting of untouched rules.
export function applyCssOps(source: string, ops: CssOp[]): ApplyResult {
  let root: postcss.Root;
  try {
    root = postcss.parse(source);
  } catch (error) {
    const message = `file is not valid CSS: ${errorMessage(error)}`;
    return { output: source, results: ops.map(() => ({ matched: 0, applied: false, error: message })), changed: false };
  }

  const results: OpResult[] = [];
  let changed = false;

  for (const op of ops) {
    try {
      const outcome = applyOne(root, op);
      if (outcome.applied) changed = true;
      results.push(outcome);
    } catch (error) {
      results.push({ matched: 0, applied: false, error: errorMessage(error) });
    }
  }

  return { output: changed ? root.toString() : source, results, changed };
}

function applyOne(root: postcss.Root, op: CssOp): OpResult {
  if (op.action === "addRule") {
    const rule = postcss.rule({ selector: op.selector });
    for (const [prop, value] of Object.entries(op.declarations)) {
      rule.append({ prop, value: String(value) });
    }
    root.append(rule);
    return { matched: 1, applied: true };
  }

  const wanted = normalizeSelector(op.selectRule);
  const matches: postcss.Rule[] = [];
  root.walkRules((rule) => {
    if (normalizeSelector(rule.selector) === wanted) matches.push(rule);
  });
  if (matches.length === 0) return { matched: 0, applied: false };

  for (const rule of matches) {
    switch (op.action) {
      case "setDecl": {
        let found = false;
        rule.walkDecls(op.prop, (decl) => {
          decl.value = op.value;
          found = true;
        });
        if (!found) rule.append({ prop: op.prop, value: op.value });
        break;
      }
      case "removeDecl":
        rule.walkDecls(op.prop, (decl) => {
          decl.remove();
        });
        break;
      case "removeRule":
        rule.remove();
        break;
    }
  }
  return { matched: matches.length, applied: true };
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
