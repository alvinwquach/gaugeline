import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import type { ScriptRead } from "../../scripts.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { sourceMapsPublic } from "../source-maps-public.js";

const ORIGIN = "https://fennel-lane.example";
const hop = (
  url: string,
  body: string,
  headers: Record<string, string> = {},
  more: Partial<Hop> = {},
): Hop => ({
  url,
  status: 200,
  headers,
  body,
  ms: 1,
  ...more,
});
const html = (head: string) =>
  buildSnapshot([
    hop(`${ORIGIN}/`, `<html><head>${head}</head><body><main>Bread</main></body></html>`, {
      "content-type": "text/html",
    }),
  ]);
const script = (path: string, text: string, more: Partial<ScriptRead> = {}): ScriptRead => ({
  url: `${ORIGIN}${path}`,
  status: 200,
  text,
  truncated: false,
  ...more,
});
const MAP = JSON.stringify({ version: 3, sources: ["a.ts", "b.ts"], sourcesContent: ["x", "y"] });

function setup(answers: Record<string, Hop[]>, scripts: ScriptRead[]) {
  const asked: string[] = [];
  const unchecked: [string, string][] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    budget: createBudget(),
    fetcher: {
      get: async (url: string) => {
        asked.push(url);
        return answers[url] ?? [hop(url, "not found", {}, { status: 404 })];
      },
      getSite: async () => [],
      stats: { requests: 0, maxInFlight: 0 },
    },
    scripts: async () => scripts,
    couldNotCheck: (url, reason) => void unchecked.push([url, reason]),
  };
  return { ctx, asked, unchecked };
}

describe("source-maps-public: unit", () => {
  it("a script that names a public map is one finding with the file, counts and no source", async () => {
    const { ctx, asked } = setup({ [`${ORIGIN}/a.js.map`]: [hop(`${ORIGIN}/a.js.map`, MAP)] }, [
      script("/a.js", "x();\n//# sourceMappingURL=a.js.map"),
    ]);
    const out = await sourceMapsPublic.run(html('<script src="/a.js"></script>'), ctx);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "source-maps-public",
      severity: "medium",
      evidence:
        "1 file names a source map anyone can fetch: /a.js (2 source files, original code included, small)",
    });
    expect(asked).toEqual([`${ORIGIN}/a.js.map`]);
    expect(JSON.stringify(out)).not.toContain("a.ts");
  });

  it("a map with file names only is worth knowing, not fix soon", async () => {
    const m = JSON.stringify({ version: 3, sources: ["a.ts"] });
    const { ctx } = setup({ [`${ORIGIN}/a.js.map`]: [hop(`${ORIGIN}/a.js.map`, m)] }, [
      script("/a.js", "//# sourceMappingURL=a.js.map"),
    ]);
    const out = await sourceMapsPublic.run(html(""), ctx);
    expect(out[0]).toMatchObject({
      severity: "low",
      evidence: "1 file names a source map anyone can fetch: /a.js (1 source file, names only)",
    });
  });

  it("the SourceMap header names a map when the file has no comment", async () => {
    const { ctx, asked } = setup({ [`${ORIGIN}/a.js.map`]: [hop(`${ORIGIN}/a.js.map`, MAP)] }, [
      script("/a.js", "x();", { sourceMap: "a.js.map" }),
    ]);
    expect(await sourceMapsPublic.run(html(""), ctx)).toHaveLength(1);
    expect(asked).toEqual([`${ORIGIN}/a.js.map`]);
  });

  it("a linked stylesheet is read too", async () => {
    const css = `${ORIGIN}/s.css`;
    const { ctx } = setup(
      {
        [css]: [hop(css, "a{}\n/*# sourceMappingURL=s.css.map */")],
        [`${ORIGIN}/s.css.map`]: [hop(`${ORIGIN}/s.css.map`, MAP)],
      },
      [],
    );
    const out = await sourceMapsPublic.run(html('<link rel="stylesheet" href="/s.css">'), ctx);
    expect(out[0]?.evidence).toContain("/s.css (2 source files");
  });
});

describe("source-maps-public: edge cases", () => {
  const page = html("");

  it("a map that answers 404, a soft 404 page and a map that is not JSON are not public", async () => {
    for (const answer of [
      [hop(`${ORIGIN}/a.js.map`, "nope", {}, { status: 404 })],
      [hop(`${ORIGIN}/a.js.map`, "<!doctype html><title>Home</title>")],
      [hop(`${ORIGIN}/a.js.map`, '{"version":3')],
    ]) {
      const { ctx, unchecked } = setup({ [`${ORIGIN}/a.js.map`]: answer }, [
        script("/a.js", "//# sourceMappingURL=a.js.map"),
      ]);
      expect(await sourceMapsPublic.run(page, ctx)).toEqual([]);
      expect(unchecked).toEqual([]);
    }
  });

  it("a refused or unreachable map, and a map cut at the size cap, are could not check", async () => {
    for (const answer of [
      [hop(`${ORIGIN}/a.js.map`, "", {}, { status: 403 })],
      [hop(`${ORIGIN}/a.js.map`, "", {}, { status: 429 })],
      [],
      [hop(`${ORIGIN}/a.js.map`, MAP.slice(0, 20), {}, { truncated: true })],
    ]) {
      const { ctx, unchecked } = setup({ [`${ORIGIN}/a.js.map`]: answer }, [
        script("/a.js", "//# sourceMappingURL=a.js.map"),
      ]);
      expect(await sourceMapsPublic.run(page, ctx)).toEqual([]);
      expect(unchecked.map((u) => u[0])).toEqual([`${ORIGIN}/a.js.map`]);
    }
  });

  it("a file cut at the size cap may have lost its comment: could not check, nothing asked", async () => {
    const { ctx, asked, unchecked } = setup({}, [script("/a.js", "x();", { truncated: true })]);
    expect(await sourceMapsPublic.run(page, ctx)).toEqual([]);
    expect(asked).toEqual([]);
    expect(unchecked).toEqual([[`${ORIGIN}/a.js`, expect.stringContaining("only the start")]]);
  });

  it("a map on another host, a javascript: value and a scheme-relative address are never asked", async () => {
    const { ctx, asked, unchecked } = setup({}, [
      script("/a.js", "//# sourceMappingURL=//maps.cdn.example/a.js.map"),
      script("/b.js", "//# sourceMappingURL=https://maps.cdn.example/b.js.map"),
      script("/c.js", "//# sourceMappingURL=javascript:alert(1)"),
    ]);
    expect(await sourceMapsPublic.run(page, ctx)).toEqual([]);
    expect(asked).toEqual([]);
    expect(unchecked).toHaveLength(3);
  });

  it("an inline data: map is counted by size, without decoding, and nothing is asked", async () => {
    const { ctx, asked } = setup({}, [
      script("/a.js", "//# sourceMappingURL=data:application/json;base64," + "A".repeat(8000)),
    ]);
    const out = await sourceMapsPublic.run(page, ctx);
    expect(out[0]?.evidence).toBe(
      "1 file names a source map anyone can fetch: /a.js (inline map, about 6 KB)",
    );
    expect(asked).toEqual([]);
  });

  it("asks at most ten maps and names the rest; the same map twice is asked once", async () => {
    const scripts = Array.from({ length: 12 }, (_, i) =>
      script(`/f${i}.js`, `//# sourceMappingURL=m${i}.map`),
    );
    scripts.push(script("/dup.js", "//# sourceMappingURL=m0.map"));
    const { ctx, asked, unchecked } = setup({}, scripts);
    await sourceMapsPublic.run(page, ctx);
    expect(asked).toHaveLength(10);
    expect(unchecked.filter((u) => u[1].includes("not asked"))).toHaveLength(2);
  });

  it("a hostile map (huge sources list, __proto__ keys) is summarised and nothing else", async () => {
    const m = `{"version":3,"__proto__":{"x":1},"sources":${JSON.stringify(Array.from({ length: 50_000 }, (_, i) => `s${i}.ts`))}}`;
    const { ctx } = setup({ [`${ORIGIN}/a.js.map`]: [hop(`${ORIGIN}/a.js.map`, m)] }, [
      script("/a.js", "//# sourceMappingURL=a.js.map"),
    ]);
    const out = await sourceMapsPublic.run(page, ctx);
    expect(out[0]?.evidence).toContain("(50000 source files, names only)");
  });

  it("with no fetcher or no scripts reader there is nothing to say", async () => {
    expect(await sourceMapsPublic.run(page, { warn: () => undefined })).toEqual([]);
  });
});

describe("source-maps-public: integration (the source-maps fixture)", () => {
  it("two maps with the original code, one with file names only, one cross-host map left alone", async () => {
    const site = await startFixture("source-maps");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ["source-maps-public"],
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        [
          "source-maps-public",
          "medium",
          "3 files name a source map anyone can fetch: /assets/app-4c9d.js (2 source files, original code included, small); /assets/legacy-5b0a.js (1 source file, original code included, small); /assets/site-7a1b.css (1 source file, names only)",
        ],
      ]);
      // Only the maps the page's own files name were asked: the cross-host one never.
      const asked = [...site.hits.keys()].filter((k) => k.endsWith(".map")).sort();
      expect(asked).toEqual([
        "/assets/app-4c9d.js.map",
        "/assets/legacy-5b0a.js.map",
        "/assets/quiet-3d1c.js.map",
        "/assets/site-7a1b.css.map",
      ]);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });
});
