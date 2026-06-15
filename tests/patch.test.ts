import { describe, expect, test } from "bun:test";
import { applyHtmlOps } from "../src/patch/html";
import { applyJsonOps } from "../src/patch/json";
import { applyCssOps } from "../src/patch/css";
import { applyPatchBatch } from "../src/patch/apply";
import type { RawOp } from "../src/patch/types";

describe("html patching", () => {
  const html = `<!doctype html><html><body><h1 class="hero">Old</h1><a id="cta" href="/x">Buy</a><span class="sold-out">x</span></body></html>`;

  test("targets by selector and applies to every match", () => {
    const src = `<ul><li class="row">a</li><li class="row">b</li></ul>`;
    const r = applyHtmlOps(src, [{ select: ".row", action: "addClass", value: "done" }]);
    expect(r.results[0]).toEqual({ matched: 2, applied: true });
    expect(r.output).toContain('class="row done"');
  });

  test("setText, setAttr, remove in one pass", () => {
    const r = applyHtmlOps(html, [
      { select: ".hero", action: "setText", value: "New" },
      { select: "#cta", action: "setAttr", name: "href", value: "/buy" },
      { select: ".sold-out", action: "remove" },
    ]);
    expect(r.changed).toBe(true);
    expect(r.output).toContain(">New<");
    expect(r.output).toContain('href="/buy"');
    expect(r.output).not.toContain("sold-out");
  });

  test("no match is reported, not an error", () => {
    const r = applyHtmlOps(html, [{ select: ".nope", action: "setText", value: "z" }]);
    expect(r.results[0]).toEqual({ matched: 0, applied: false });
    expect(r.changed).toBe(false);
    expect(r.output).toBe(html);
  });

  test("invalid selector fails only that op", () => {
    const r = applyHtmlOps(html, [
      { select: "::::", action: "remove" },
      { select: ".hero", action: "setText", value: "ok" },
    ]);
    expect(r.results[0].error).toBeTruthy();
    expect(r.results[1]).toEqual({ matched: 1, applied: true });
  });

  test("append/prepend/replaceWith insert markup", () => {
    const r = applyHtmlOps(`<div id="b"><p>mid</p></div>`, [
      { select: "#b", action: "prepend", value: "<span>first</span>" },
      { select: "#b", action: "append", value: "<span>last</span>" },
    ]);
    expect(r.output).toBe(`<div id="b"><span>first</span><p>mid</p><span>last</span></div>`);
  });
});

describe("json patching", () => {
  const json = `{\n  "items": [\n    { "price": 10 },\n    { "price": 20 }\n  ],\n  "title": "Hi"\n}\n`;

  test("set, append via '-', remove, miss", () => {
    const r = applyJsonOps(json, [
      { pointer: "/items/0/price", action: "set", value: 42 },
      { pointer: "/items/-", action: "set", value: { price: 99 } },
      { pointer: "/title", action: "remove" },
      { pointer: "/missing", action: "remove" },
    ]);
    expect(r.results.map((x) => x.applied)).toEqual([true, true, true, false]);
    const parsed = JSON.parse(r.output);
    expect(parsed.items).toEqual([{ price: 42 }, { price: 20 }, { price: 99 }]);
    expect(parsed.title).toBeUndefined();
  });

  test("insert shifts the array; append pushes", () => {
    const r = applyJsonOps(`{"a":[1,3]}`, [
      { pointer: "/a/1", action: "insert", value: 2 },
      { pointer: "/a", action: "append", value: 4 },
    ]);
    expect(JSON.parse(r.output).a).toEqual([1, 2, 3, 4]);
  });

  test("set on root replaces document", () => {
    const r = applyJsonOps(`{"old":true}`, [{ pointer: "", action: "set", value: { new: 1 } }]);
    expect(JSON.parse(r.output)).toEqual({ new: 1 });
  });

  test("preserves tab indentation", () => {
    const r = applyJsonOps(`{\n\t"x": 1\n}`, [{ pointer: "/x", action: "set", value: 2 }]);
    expect(r.output).toBe(`{\n\t"x": 2\n}`);
  });

  test("unparseable JSON fails every op without writing", () => {
    const r = applyJsonOps(`{not json`, [{ pointer: "/x", action: "set", value: 1 }]);
    expect(r.changed).toBe(false);
    expect(r.results[0].error).toContain("not valid JSON");
  });

  test("set auto-creates missing intermediate object parents", () => {
    const r = applyJsonOps(`{}`, [
      { pointer: "/pages/pricing.html/tweaks/primaryColor/value", action: "set", value: "#0A84FF" },
    ]);
    expect(r.results[0]).toEqual({ matched: 1, applied: true });
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.output)).toEqual({
      pages: { "pricing.html": { tweaks: { primaryColor: { value: "#0A84FF" } } } },
    });
  });

  test("set through an existing scalar is a no-op conflict (not clobbered)", () => {
    const src = `{"a":5}`;
    const r = applyJsonOps(src, [{ pointer: "/a/b", action: "set", value: 1 }]);
    expect(r.results[0]).toEqual({ matched: 0, applied: false });
    expect(r.changed).toBe(false);
    expect(r.output).toBe(src);
  });

  test("set descending through an existing object preserves siblings", () => {
    const r = applyJsonOps(`{"pages":{"x.html":{"tweaks":{"keep":1}}}}`, [
      { pointer: "/pages/x.html/tweaks/add", action: "set", value: 2 },
    ]);
    expect(r.results[0]).toEqual({ matched: 1, applied: true });
    expect(JSON.parse(r.output).pages["x.html"].tweaks).toEqual({ keep: 1, add: 2 });
  });

  test("auto-create is set-only: remove/append/insert still no-op on missing parent", () => {
    const r = applyJsonOps(`{}`, [
      { pointer: "/nope/x", action: "remove" },
      { pointer: "/nope/x", action: "append", value: 1 },
      { pointer: "/nope/x", action: "insert", value: 1 },
    ]);
    expect(r.results).toEqual([
      { matched: 0, applied: false },
      { matched: 0, applied: false },
      { matched: 0, applied: false },
    ]);
    expect(r.changed).toBe(false);
  });

  test("array set semantics unaffected: '-' appends, index replaces", () => {
    const r = applyJsonOps(`{"arr":[1,2]}`, [
      { pointer: "/arr/0", action: "set", value: 9 },
      { pointer: "/arr/-", action: "set", value: 3 },
    ]);
    expect(r.results.map((x) => x.applied)).toEqual([true, true]);
    expect(JSON.parse(r.output).arr).toEqual([9, 2, 3]);
  });
});

describe("css patching", () => {
  const css = `.btn {\n  color: red;\n  padding: 4px;\n}\n.hidden { display: none; }\n`;

  test("setDecl updates existing and appends new; removeRule; addRule", () => {
    const r = applyCssOps(css, [
      { selectRule: ".btn", action: "setDecl", prop: "color", value: "#D97757" },
      { selectRule: ".btn", action: "setDecl", prop: "margin", value: "0" },
      { selectRule: ".hidden", action: "removeRule" },
      { action: "addRule", selector: ".new", declarations: { gap: "8px" } },
    ]);
    expect(r.output).toContain("color: #D97757");
    expect(r.output).toContain("margin: 0");
    expect(r.output).not.toContain("display: none");
    expect(r.output).toContain(".new");
    expect(r.output).toContain("gap: 8px");
  });

  test("selector whitespace is normalized when matching", () => {
    const r = applyCssOps(`.a  >  .b { color: red }`, [
      { selectRule: ".a > .b", action: "setDecl", prop: "color", value: "blue" },
    ]);
    expect(r.results[0].matched).toBe(1);
    expect(r.output).toContain("color: blue");
  });

  test("no matching rule is reported, not an error", () => {
    const r = applyCssOps(css, [{ selectRule: ".ghost", action: "removeRule" }]);
    expect(r.results[0]).toEqual({ matched: 0, applied: false });
  });
});

describe("batch dispatcher", () => {
  const files = new Map<string, string>([
    ["index.html", `<h1 class="t">Old</h1>`],
    ["data.json", `{"n":1}`],
    ["style.css", `.x { color: red }`],
  ]);
  const read = async (f: string) => files.get(f) ?? null;

  test("routes ops to the right applier by extension and reports per-op", async () => {
    const ops: RawOp[] = [
      { file: "index.html", select: ".t", action: "setText", value: "New" },
      { file: "data.json", pointer: "/n", action: "set", value: 2 },
      { file: "style.css", selectRule: ".x", action: "setDecl", prop: "color", value: "blue" },
    ];
    const r = await applyPatchBatch(ops, read);
    expect(r.ok).toBe(true);
    expect(r.outputs.get("index.html")).toContain(">New<");
    expect(JSON.parse(r.outputs.get("data.json")!).n).toBe(2);
    expect(r.outputs.get("style.css")).toContain("color: blue");
  });

  test("one invalid op fails the whole batch (atomic, nothing written)", async () => {
    const ops: RawOp[] = [
      { file: "index.html", select: ".t", action: "setText", value: "New" },
      { file: "data.json", pointer: "/n", action: "bogus", value: 2 },
    ];
    const r = await applyPatchBatch(ops, read);
    expect(r.ok).toBe(false);
    expect(r.outputs.size).toBe(0);
    expect(r.results[1].error).toContain("not valid for json");
  });

  test("unsupported file type and missing file are op errors", async () => {
    const r = await applyPatchBatch(
      [
        { file: "notes.txt", select: "x", action: "remove" },
        { file: "ghost.html", select: ".t", action: "remove" },
      ],
      read,
    );
    expect(r.ok).toBe(false);
    expect(r.results[0].error).toContain("unsupported file type");
    expect(r.results[1].error).toContain("file not found");
  });

  test("op missing a file is rejected", async () => {
    const r = await applyPatchBatch([{ select: ".t", action: "remove" } as RawOp], read);
    expect(r.results[0].error).toContain("missing");
  });
});
