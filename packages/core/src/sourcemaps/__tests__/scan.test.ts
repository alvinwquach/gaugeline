import { describe, expect, it } from "vitest";
import { mapReference, readSourceMap, resolveMapAddress } from "../scan.js";

const FILE = "https://fennel-lane.example/assets/app-4c9d.js";

describe("source maps: the reference in a file", () => {
  it("reads a // comment, a CSS comment and the last one when a file has several", () => {
    expect(mapReference("a();\n//# sourceMappingURL=app.js.map\n")).toEqual({
      kind: "url",
      ref: "app.js.map",
    });
    expect(mapReference("a{}\n/*# sourceMappingURL=site.css.map */")).toEqual({
      kind: "url",
      ref: "site.css.map",
    });
    expect(
      mapReference("//# sourceMappingURL=old.map\nb();\n//@ sourceMappingURL=new.js.map"),
    ).toEqual({ kind: "url", ref: "new.js.map" });
  });

  it("says nothing for a file with no comment, or text that only mentions the name", () => {
    expect(mapReference("a();")).toBeUndefined();
    expect(mapReference('const re = "sourceMappingURL=";')).toBeUndefined();
    expect(mapReference("")).toBeUndefined();
  });

  it("counts an inline data: map without decoding it", () => {
    const body = "a();\n//# sourceMappingURL=data:application/json;base64," + "A".repeat(4000);
    expect(mapReference(body)).toEqual({ kind: "inline", bytes: 3000 });
  });

  it("hostile values are invalid, not followed", () => {
    for (const ref of [
      "javascript:alert(1)",
      "x".repeat(5000),
      "a\u0001b.map",
      "bad" + String.fromCharCode(0xd800) + ".map",
    ])
      expect(mapReference(`a();\n//# sourceMappingURL=${ref}\n`)?.kind, ref).toBe("url");
  });

  it("a file of megabytes of near-misses is scanned in linear time", () => {
    const body = "//# sourceMappingURL".repeat(200_000) + "/*# sourceMappingURL";
    const t = Date.now();
    expect(mapReference(body)).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(1500);
  });
});

describe("source maps: which address is asked", () => {
  it("resolves a relative or absolute-path reference on the file's own origin", () => {
    expect(resolveMapAddress("app-4c9d.js.map", FILE)).toEqual({
      url: "https://fennel-lane.example/assets/app-4c9d.js.map",
    });
    expect(resolveMapAddress("/maps/app.map", FILE)).toEqual({
      url: "https://fennel-lane.example/maps/app.map",
    });
  });

  it("never follows another origin, a scheme that is not http(s), or an unreadable value", () => {
    expect(resolveMapAddress("//maps.cdn.example/a.map", FILE)).toEqual({ skip: "cross-origin" });
    expect(resolveMapAddress("https://other.example/a.map", FILE)).toEqual({
      skip: "cross-origin",
    });
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:application/json;base64,e30=",
      "a\u0001b.map",
      "bad" + String.fromCharCode(0xd800) + ".map",
      "x".repeat(5000),
      "",
    ])
      expect(resolveMapAddress(bad, FILE), bad).toEqual({ skip: "unsupported" });
  });
});

describe("source maps: does it parse as one", () => {
  const map = (o: unknown) => JSON.stringify(o);

  it("counts files and says whether the original code is included, never keeping either", () => {
    expect(
      readSourceMap(
        map({ version: 3, sources: ["a", "b"], sourcesContent: ["x".repeat(10), "y"] }),
      ),
    ).toEqual({ version: 3, sources: 2, withContent: true, contentBytes: 11, sizeClass: "small" });
    expect(readSourceMap(map({ version: 3, sources: ["a"] }))).toEqual({
      version: 3,
      sources: 1,
      withContent: false,
      contentBytes: 0,
      sizeClass: "none",
    });
  });

  it("size classes by the original code's size: small under 100 KB, medium under 1 MB, then large", () => {
    const of = (n: number) =>
      readSourceMap(map({ version: 3, sources: ["a"], sourcesContent: ["z".repeat(n)] }))
        ?.sizeClass;
    expect(of(99_999)).toBe("small");
    expect(of(100_000)).toBe("medium");
    expect(of(1_000_000)).toBe("large");
  });

  it("accepts an index map (sections) and the )]}' prefix, and refuses anything else", () => {
    expect(readSourceMap(map({ version: 3, sections: [{ offset: {}, map: {} }] }))?.sources).toBe(
      0,
    );
    expect(readSourceMap(")]}'\n" + map({ version: 3, sources: ["a"] }))?.sources).toBe(1);
    for (const text of [
      "<!doctype html><title>Not found</title>",
      "",
      "[]",
      "null",
      map({ version: 2, sources: [] }),
      map({ sources: ["a"] }),
      map({ version: 3 }),
      '{"version":3,"sources":["a"]',
    ])
      expect(readSourceMap(text), text).toBeUndefined();
  });

  it("a __proto__ key is plain data and changes nothing", () => {
    const text = '{"version":3,"__proto__":{"sources":["x","y","z"]},"sources":["a"]}';
    expect(readSourceMap(text)?.sources).toBe(1);
    expect(({} as { sources?: unknown }).sources).toBeUndefined();
  });
});
