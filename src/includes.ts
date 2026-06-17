// Serve-time transclusion of `<see-include src="…">` elements (Pillar B — token economy). The LLM
// authors a fragment once under e.g. `shared/` and references it from many pages; the content handler
// expands the references when serving a bundle's HTML, so the model's output stays small. Expansion
// is recursive (a fragment may include others) but bounded on depth, total count, and per-fragment
// bytes, and cycle-guarded — a missing/looping/oversized reference expands to nothing rather than
// breaking the page. This module is pure: the caller supplies a guarded resource loader.

const INCLUDE_TAG = "see-include";
const MAX_INCLUDE_DEPTH = 8; // nesting limit (fragment → fragment → …)
const MAX_INCLUDES = 100; // total expansions per page render (DoS bound)

// Loads a resource's text by its normalized, root-relative path, or null if missing/oversized/outside
// the share root. The loader owns the filesystem boundary check; this module only normalizes for
// cycle keys and rejects traversal as defense-in-depth.
export type IncludeLoader = (path: string) => Promise<string | null>;

// Normalize an include `src` to a root-relative, "/"-joined resource path. Strips leading slashes and
// "." segments; rejects empty paths and any ".." traversal (the loader also enforces the root
// boundary, but rejecting here keeps the cycle key canonical and the intent explicit).
export function normalizeIncludePath(src: string): string | null {
  const segments: string[] = [];
  for (const seg of src.trim().replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    segments.push(seg);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

// Expand every `<see-include>` in `html`. Returns the HTML with references replaced by their
// (recursively expanded) fragments. Safe on malformed markup (HTMLRewriter parses leniently).
export async function expandIncludes(html: string, load: IncludeLoader): Promise<string> {
  if (!html.includes(INCLUDE_TAG)) return html; // fast path: nothing to do
  return expand(html, load, MAX_INCLUDE_DEPTH, new Set<string>(), { count: 0 });
}

async function expand(
  html: string,
  load: IncludeLoader,
  depth: number,
  chain: Set<string>,
  budget: { count: number },
): Promise<string> {
  const srcs = await collectSrcs(html);
  if (srcs.size === 0) return html;
  // Pre-resolve each unique src to its expanded HTML OUTSIDE the rewriter handlers (which are sync),
  // then a second pass does the surgical replacement.
  const resolved = new Map<string, string>();
  for (const src of srcs) {
    resolved.set(src, await resolveOne(src, load, depth, chain, budget));
  }
  return replaceSrcs(html, resolved);
}

async function resolveOne(
  src: string,
  load: IncludeLoader,
  depth: number,
  chain: Set<string>,
  budget: { count: number },
): Promise<string> {
  if (depth <= 0 || budget.count >= MAX_INCLUDES) return "";
  const path = normalizeIncludePath(src);
  if (!path || chain.has(path)) return ""; // unresolvable or a cycle → expand to nothing
  const fragment = await load(path);
  if (fragment == null) return "";
  budget.count += 1;
  const childChain = new Set(chain);
  childChain.add(path);
  return expand(fragment, load, depth - 1, childChain, budget);
}

async function collectSrcs(html: string): Promise<Set<string>> {
  const srcs = new Set<string>();
  const res = new HTMLRewriter()
    .on(INCLUDE_TAG, {
      element(el) {
        const src = el.getAttribute("src");
        if (src != null) srcs.add(src);
      },
    })
    .transform(new Response(html));
  await res.text();
  return srcs;
}

async function replaceSrcs(html: string, resolved: Map<string, string>): Promise<string> {
  const res = new HTMLRewriter()
    .on(INCLUDE_TAG, {
      element(el) {
        const src = el.getAttribute("src");
        // Replace the whole element (and any fallback children) with the already-expanded fragment;
        // an unknown/empty src drops the element entirely. {html:true} inserts markup, not text.
        el.replace((src != null ? resolved.get(src) : "") ?? "", { html: true });
      },
    })
    .transform(new Response(html));
  return res.text();
}
