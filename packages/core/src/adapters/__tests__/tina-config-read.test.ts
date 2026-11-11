import { describe, expect, it } from "vitest";
import { readTinaConfig, TINA_CONFIG_LIMITS } from "../tina-config-read.js";
import { TINA_CONFIG } from "./tina-fixture.js";

const wrap = (collections: string, extra = ""): string =>
  `import { defineConfig } from "tinacms";\nexport default defineConfig({ ${extra} schema: { collections: ${collections} } });`;

function ok(text: string) {
  const r = readTinaConfig(text);
  if (!r.ok) throw new Error(`not read: ${r.reason}`);
  return r;
}

describe("reading tina/config.ts as text", () => {
  it("reads the collections of a freelancer's config: name, folder, format, address", () => {
    const r = ok(TINA_CONFIG);
    expect(r.collections.map((c) => [c.name, c.dir, c.format, c.permalink])).toEqual([
      ["post", "content/posts", "mdx", "/news/{filename}"],
      ["bread", "content/bread", "md", "/bread/{slug}"],
      ["page", "content/pages", "json", "/{filename}"],
    ]);
    expect(r.notRead).toEqual([]);
    // The commented-out `collections: [` and the variables above the config are not mistaken for it.
    expect(r.tinaCloud).toBe(true);
  });

  it("never runs the file: top-level code, a throw and a getter have no effect", () => {
    const g = globalThis as { __tinaRan?: boolean };
    delete g.__tinaRan;
    const text = wrap(
      `[{ name: "post", path: "content/posts", get label() { globalThis.__tinaRan = true; return "x"; } }, { name: "page", path: "content/pages" }]`,
      `onLoad: (globalThis.__tinaRan = true), `,
    );
    const r = ok(`globalThis.__tinaRan = true; throw new Error("run");\nprocess.exit(1);\n${text}`);
    expect(g.__tinaRan).toBeUndefined();
    // The collection with a getter has computed parts and is not read; the other one is.
    expect(r.collections.map((c) => c.name)).toEqual(["page"]);
    expect(r.notRead).toHaveLength(1);
  });

  it("defaults the format to md and filters files by it", () => {
    const [c] = ok(wrap(`[{ name: "a", path: "content/a" }]`)).collections;
    expect(c?.format).toBe("md");
    expect(c?.accepts("x.md")).toBe(true);
    expect(c?.accepts("x.mdx")).toBe(false);
    expect(c?.accepts("deep/x.MD")).toBe(true);
    expect(c?.accepts("noext")).toBe(false);
  });

  it("applies match.include and match.exclude to the path without its extension", () => {
    const [c] = ok(
      wrap(
        `[{ name: "a", path: "content/a/", format: "yaml", match: { include: "{home,about}", exclude: "x/**" } }]`,
      ),
    ).collections;
    expect(c?.dir).toBe("content/a");
    expect(c?.accepts("home.yaml")).toBe(true);
    expect(c?.accepts("about.yml")).toBe(true);
    expect(c?.accepts("blog.yaml")).toBe(false);
    const [d] = ok(
      wrap(`[{ name: "b", path: "content/b", match: { include: "**/*", exclude: "old/**" } }]`),
    ).collections;
    expect(d?.accepts("old/a.md")).toBe(false);
    expect(d?.accepts("new/deep/a.md")).toBe(true);
    expect(d?.accepts("a.md")).toBe(true);
  });

  it("reads breadcrumbs and a slug field as address tokens, and a plain string as a fixed address", () => {
    const r = ok(
      wrap(
        `[
          { name: "a", path: "content/a", ui: { router: ({ document }) => \`/guides/\${document._sys.breadcrumbs.join("/")}\` } },
          { name: "b", path: "content/b", ui: { router: (props) => { return \`/b/\${props.document.slug}\`; } } },
          { name: "c", path: "content/c", ui: { router: ({ document }) => (\`/c/\${ document.slug }\`) } },
          { name: "d", path: "content/d", ui: { router: () => "/about" } },
        ]`,
      ),
    );
    expect(r.collections.map((c) => [c.name, c.permalink])).toEqual([
      ["a", "/guides/{path}"],
      ["b", undefined],
      ["c", "/c/{slug}"],
      ["d", "/about"],
    ]);
    // `props.document.slug` is not one of the forms read: the collection is read, its items have no address.
    expect(r.collections.find((c) => c.name === "b")?.permalink).toBeUndefined();
    expect(r.notRead.map((n) => [n.name, n.kind])).toEqual([["b", "address"]]);
  });

  it("a router that is more than one template gives no address, and says so", () => {
    const r = ok(
      wrap(
        `[{ name: "a", path: "content/a", ui: { router: ({ document }) => document._sys.filename === "home" ? "/" : \`/\${document._sys.filename}\` } }]`,
      ),
    );
    expect(r.collections[0]?.permalink).toBeUndefined();
    expect(r.notRead).toEqual([expect.objectContaining({ name: "a", kind: "address" })]);
  });

  it("an address that is not a path on the site is dropped: a host, a double slash, odd characters", () => {
    for (const router of [
      "() => `//evil.example/${document._sys.filename}`",
      "() => `https://evil.example/${document._sys.filename}`.replace",
      "({ document }) => `/a b/${document._sys.filename}`",
      "({ document }) => `/a/<${document._sys.filename}>`",
      "({ document }) => `${document._sys.filename}`",
    ]) {
      const r = ok(wrap(`[{ name: "a", path: "content/a", ui: { router: ${router} } }]`));
      expect(r.collections[0]?.permalink, router).toBeUndefined();
    }
  });

  it("a collection that is not written out is not read, with a fixed reason", () => {
    const r = ok(
      wrap(`[postCollection, ...others, { name: "page", path: "content/pages" }, require("./x")]`),
    );
    expect(r.collections.map((c) => c.name)).toEqual(["page"]);
    expect(r.notRead.map((n) => n.name)).toEqual(["collection 1", "collection 2", "collection 4"]);
    for (const n of r.notRead) {
      expect(n.kind).toBe("collection");
      expect(n.reason).toMatch(/is not written out in tina\/config\.ts/);
    }
  });

  it("refuses a name, path, format or match it cannot be sure of, and quotes none of them", () => {
    const hostile = "SECRET-FROM-THE-CONFIG";
    const bad = [
      `{ name: ${hostile}, path: "content/a" }`,
      `{ name: "a b", path: "content/a" }`,
      `{ name: "a", path: dir }`,
      `{ name: "a", path: \`\${${hostile}}/posts\` }`,
      `{ name: "a", path: "../outside" }`,
      `{ name: "a", path: "/etc" }`,
      `{ name: "a", path: ".git/hooks" }`,
      `{ name: "a", path: "content/.hidden" }`,
      `{ name: "a", path: "node_modules/x" }`,
      `{ name: "a", path: "" }`,
      `{ name: "a" }`,
      `{ name: "a", path: "content/a", format: fmt }`,
      `{ name: "a", path: "content/a", format: "php" }`,
      `{ name: "a", path: "content/a", match: include }`,
      `{ name: "a", path: "content/a", match: { include: pattern } }`,
      `{ name: "a", path: "content/a", match: { include: "[ab]*" } }`,
      `{ name: "a", path: "content/a", match: { include: "!(x)" } }`,
      `{ name: "a", path: "content/a", match: { other: "x" } }`,
      `{ name: "a", path: "content/a", ...shared }`,
    ];
    const r = ok(wrap(`[${bad.join(", ")}, { name: "good", path: "content/good" }]`));
    expect(r.collections.map((c) => c.name)).toEqual(["good"]);
    expect(r.notRead).toHaveLength(bad.length);
    for (const n of r.notRead) {
      expect(n.reason).not.toContain(hostile);
      expect(n.reason).not.toContain("outside");
      expect(n.reason).not.toContain("etc");
    }
  });

  it("a name used twice is read once, the first", () => {
    const r = ok(wrap(`[{ name: "a", path: "content/one" }, { name: "a", path: "content/two" }]`));
    expect(r.collections.map((c) => c.dir)).toEqual(["content/one"]);
    expect(r.notRead).toEqual([expect.objectContaining({ name: "a" })]);
  });

  it("a repeated key keeps its first value", () => {
    const r = ok(wrap(`[{ name: "a", path: "content/one", path: "content/two" }]`));
    expect(r.collections[0]?.dir).toBe("content/one");
  });

  it("tinaCloud is true only with a non-empty clientId", () => {
    expect(ok(wrap("[]", 'clientId: "abc",')).tinaCloud).toBe(true);
    expect(ok(wrap("[]", "clientId: process.env.ID,")).tinaCloud).toBe(true);
    expect(ok(wrap("[]", 'clientId: "",')).tinaCloud).toBe(false);
    expect(ok(wrap("[]", "clientId: undefined,")).tinaCloud).toBe(false);
    expect(ok(wrap("[]")).tinaCloud).toBe(false);
    // The value is never kept or reported.
    expect(JSON.stringify(ok(wrap("[]", 'clientId: "id-1234",')))).not.toContain("id-1234");
  });

  it("is not fooled by comments, strings and templates that look like code", () => {
    const text = `// collections: [ { name: "ghost", path: "x" } ]
/* collections: [ { name: "ghost2", path: "x" } ] */
const s = "collections: [ { name: 'ghost3' } ]";
const t = \`collections: [ \${"}"} ]\`;
${wrap(`[{ name: "real", path: "content/real" }]`)}`;
    expect(ok(text).collections.map((c) => c.name)).toEqual(["real"]);
  });

  it("text it cannot read is not read at all, never a guess", () => {
    for (const text of [
      "",
      "export default defineConfig({})",
      wrap("collectionsFromElsewhere"),
      wrap("[...all]").replace("[...all]", "allCollections()"),
      'export default { schema: { collections: [ { name: "a", path: "content/a" ',
      'const x = "unterminated;\n' + wrap("[]"),
      "const x = `unterminated",
      "/* unterminated",
      wrap('[{ name: "a", path: "x" ) ]'),
      wrap("[" + "[".repeat(100) + "]".repeat(100) + "]"),
    ]) {
      const r = readTinaConfig(text);
      if (r.ok) expect(r.collections, text).toEqual([]);
      else expect(r.reason).toMatch(/tina\/config\.ts/);
    }
  });

  it("does not hang or throw on adversarial text", () => {
    for (const text of [
      "[".repeat(100_000),
      "collections: [".repeat(10_000),
      wrap(`[{ name: "a", path: "x", ${"a: {".repeat(500)}`),
      "`${".repeat(10_000),
      wrap(`[${"{ name: 'a' },".repeat(TINA_CONFIG_LIMITS.collections + 5)}]`),
      "}".repeat(1000) + wrap("[]"),
      wrap("[ ) ]"),
      wrap("[ } ]"),
      wrap("[{ ) }]"),
    ]) {
      expect(() => readTinaConfig(text)).not.toThrow();
    }
    expect(readTinaConfig(wrap(`[${"{ name: 'a' },".repeat(300)}]`)).ok).toBe(false);
  });

  it("a file over the size bound is not read", () => {
    const big = wrap("[]") + "\n//" + "x".repeat(TINA_CONFIG_LIMITS.bytes);
    const r = readTinaConfig(big);
    expect(r.ok).toBe(false);
  });

  it("lone surrogates and control characters in the text do not throw", () => {
    const text = wrap(`[{ name: "a", path: "content/a", label: "\uD800 \u0000 \uDFFF" }]`);
    expect(() => readTinaConfig(text)).not.toThrow();
    expect(ok(text).collections.map((c) => c.name)).toEqual(["a"]);
  });
});
