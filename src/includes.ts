// Serve-time transclusion of `<see-include src="…">` elements (Pillar B — token economy). The LLM
// authors a fragment once under e.g. `shared/` and references it from many pages; the content handler
// expands the references when serving a bundle's HTML, so the model's output stays small. Expansion
// is recursive (a fragment may include others) but bounded on depth, unique loads, total OUTPUT bytes,
// and per-fragment bytes (the loader's job), and cycle-guarded — a missing/looping/oversized/over-
// budget reference expands to nothing rather than breaking the page. This module is pure: the caller
// supplies a guarded resource loader.

const INCLUDE_TAG = "see-include";
const MAX_INCLUDE_DEPTH = 8; // nesting limit (fragment → fragment → …)
const MAX_INCLUDE_READS = 100; // unique fragment loads per page render
// Total transcluded bytes EMITTED across all placements. This — not the read count — is what bounds a
// multiplicative bomb: a 2-file bundle (one page with N copies of `<see-include src="big">` + one big
// fragment) reuses a single read but would otherwise duplicate it N times, and nesting multiplies
// that. Capping emitted bytes makes a hostile bundle drop excess includes instead of exhausting memory.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// Loads a resource's text by its normalized, root-relative path, or null if missing/oversized/outside
// the share root. The loader owns the filesystem boundary check; this module only normalizes for
// cycle keys and rejects traversal as defense-in-depth.
export type IncludeLoader = (path: string) => Promise<string | null>;

type Budget = { reads: number; bytes: number };

// Normalize an include `src` to a root-relative, "/"-joined resource path. Strips leading slashes and
// "." segments; rejects empty paths and any ".." traversal (the loader also enforces the root
// boundary, but rejecting here keeps the cycle key canonical and the intent explicit). Backslashes are
// folded to "/" so a "..\.." style reference can't slip a traversal segment past the "/"-split.
export function normalizeIncludePath(src: string): string | null {
  const segments: string[] = [];
  for (const seg of src.trim().replace(/\\/g, "/").replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    segments.push(seg);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

// Expand every `<see-include>` in `html`. Returns the HTML with references replaced by their
// (recursively expanded) fragments. Safe on malformed markup (HTMLRewriter parses leniently).
export async function expandIncludes(html: string, load: IncludeLoader): Promise<string> {
  // Fast path: nothing to do. Case-insensitive because HTML tag names are (the rewriter selector is
  // too) — a literal `<SEE-INCLUDE>` must not slip through unexpanded.
  if (!html.toLowerCase().includes(INCLUDE_TAG)) return html;
  return expand(html, load, MAX_INCLUDE_DEPTH, new Set<string>(), { reads: 0, bytes: 0 });
}

async function expand(
  html: string,
  load: IncludeLoader,
  depth: number,
  chain: Set<string>,
  budget: Budget,
): Promise<string> {
  const { srcs, total } = await collectSrcs(html);
  if (total === 0) return html; // no <see-include> elements at all
  // Pre-resolve each unique src to its expanded HTML OUTSIDE the rewriter handlers (which are sync),
  // then a second pass does the surgical replacement. We replace whenever ANY include element exists,
  // so a no-src/empty-src element is always stripped (never left as stray markup).
  const resolved = new Map<string, string>();
  for (const src of srcs) {
    resolved.set(src, await resolveOne(src, load, depth, chain, budget));
  }
  return replaceSrcs(html, resolved, budget);
}

async function resolveOne(
  src: string,
  load: IncludeLoader,
  depth: number,
  chain: Set<string>,
  budget: Budget,
): Promise<string> {
  if (depth <= 0 || budget.reads >= MAX_INCLUDE_READS) return "";
  const path = normalizeIncludePath(src);
  if (!path || chain.has(path)) return ""; // unresolvable or a cycle → expand to nothing
  const fragment = await load(path);
  if (fragment == null) return "";
  budget.reads += 1;
  const childChain = new Set(chain);
  childChain.add(path);
  return expand(fragment, load, depth - 1, childChain, budget);
}

async function collectSrcs(html: string): Promise<{ srcs: Set<string>; total: number }> {
  const srcs = new Set<string>();
  let total = 0;
  const res = new HTMLRewriter()
    .on(INCLUDE_TAG, {
      element(el) {
        total += 1;
        const src = el.getAttribute("src");
        if (src != null) srcs.add(src);
      },
    })
    .transform(new Response(html));
  await res.text();
  return { srcs, total };
}

async function replaceSrcs(html: string, resolved: Map<string, string>, budget: Budget): Promise<string> {
  const res = new HTMLRewriter()
    .on(INCLUDE_TAG, {
      element(el) {
        const src = el.getAttribute("src");
        const rep = (src != null ? resolved.get(src) : "") ?? "";
        // Drop a placement that would push total emitted bytes past the budget — bounds the
        // multiplicative blowup (reuse + nesting) to ~MAX_OUTPUT_BYTES of transcluded content.
        if (rep && budget.bytes + rep.length > MAX_OUTPUT_BYTES) {
          el.replace("", { html: true });
          return;
        }
        budget.bytes += rep.length;
        // Replace the whole element (and any fallback children) with the already-expanded fragment;
        // an unknown/empty src drops the element entirely. {html:true} inserts markup, not text.
        el.replace(rep, { html: true });
      },
    })
    .transform(new Response(html));
  return res.text();
}
