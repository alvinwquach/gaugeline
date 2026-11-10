import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../errors.js";
import { extractGroq } from "../extract.js";
import { readGroq } from "../shape.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A folder holding these files (paths with `/`), and its path. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-groq-"));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const full = join(dir, ...name.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

const paths = (r: Awaited<ReturnType<typeof extractGroq>>, type: string) =>
  r.queries.find((q) => q.type === type)?.fields.map((f) => f.path);

describe("extractGroq: unit", () => {
  it("a groq tagged template, a defineQuery call and a query imported from another file each give one shape", async () => {
    const dir = tree({
      "a.ts": 'import groq from "groq";\nexport const q = groq`*[_type == "post"]{ title }`;\n',
      "b.ts":
        'import { defineQuery } from "next-sanity";\nexport const q = defineQuery("*[_type == \\"event\\"]{ date }");\n',
      "queries.ts":
        'import groq from "groq";\nexport const menuQuery = groq`*[_type == "menuItem"]{ name }`;\n',
      "page.tsx":
        'import { menuQuery } from "./queries";\nexport default async function Page() { return <p>{await fetchIt(menuQuery)}</p>; }\n',
    });
    const r = await extractGroq(dir);
    expect(r.unreadable).toEqual([]);
    expect(r.queries.map((q) => [q.type, q.source.file])).toEqual([
      ["post", "a.ts"],
      ["event", "b.ts"],
      ["menuItem", "queries.ts"],
    ]);
  });

  it("finds a defineQuery with a template literal, and a groq tag reached through a namespace", async () => {
    const dir = tree({
      "a.ts": 'export const q = defineQuery(`*[_type == "post"]{ title }`);\n',
      "b.ts":
        'export const q = sanity.groq`*[_type == "page"]{ title }`;\nexport const r = sanity.defineQuery("*[_type == \\"tag\\"]");\n',
    });
    const r = await extractGroq(dir);
    expect(r.queries.map((q) => q.type)).toEqual(["post", "page", "tag"]);
  });

  it("a groq template inside defineQuery is read once, as the template", async () => {
    const dir = tree({
      "a.ts": 'export const q = defineQuery(groq`*[_type == "post"]{ title }`);\n',
    });
    const r = await extractGroq(dir);
    expect(r.queries).toHaveLength(1);
    expect(r.unreadable).toEqual([]);
  });

  it("a tag or call with another name is not GROQ", async () => {
    const dir = tree({
      "a.ts":
        'export const q = html`*[_type == "post"]{ title }`;\nexport const r = fetchQuery("*[_type == \\"post\\"]");\n',
    });
    expect(await extractGroq(dir)).toEqual({ queries: [], unreadable: [] });
  });

  it("reads each of .ts, .tsx, .js, .jsx and .mjs, and only those", async () => {
    const q = (t: string) => `export const q = groq\`*[_type == "${t}"]{ a }\`;\n`;
    const dir = tree({
      "a.ts": q("t1"),
      "b.tsx": q("t2"),
      "c.js": q("t3"),
      "d.jsx": q("t4"),
      "e.mjs": q("t5"),
      "f.cjs": q("t6"),
      "g.md": q("t7"),
      "h.json": "{}",
    });
    const r = await extractGroq(dir);
    expect(r.queries.map((x) => x.type)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("a jsx file and a tsx file with markup around the query are read", async () => {
    const dir = tree({
      "a.tsx":
        'const q = groq`*[_type == "post"]{ title }`;\nexport default () => <main data-q={q}>{q}</main>;\n',
      "b.jsx":
        'const q = groq`*[_type == "page"]{ title }`;\nexport default () => <main data-q={q}>{q}</main>;\n',
    });
    expect((await extractGroq(dir)).queries.map((x) => x.type)).toEqual(["post", "page"]);
  });

  describe("field paths", () => {
    const read = (q: string) => readGroq(q, { file: "q.ts", line: 1 });

    it('"slug": slug.current gives slug.current, not the name it is renamed to', () => {
      const [shape] = read('*[_type == "post"]{ "slug": slug.current }').shapes;
      expect(shape?.fields).toEqual([
        { path: "slug.current", deref: false, source: { file: "q.ts", line: 1 } },
      ]);
    });

    it("topic->{title} gives topic->title with deref true", () => {
      const [shape] = read('*[_type == "post"]{ topic->{ title } }').shapes;
      expect(shape?.fields).toEqual([
        { path: "topic->title", deref: true, source: { file: "q.ts", line: 1 } },
      ]);
    });

    it("a dereference in a path, an array of references and a nested projection after one", () => {
      const [shape] = read(
        '*[_type == "post"]{ "t": topic->title, authors[]->{ name, org->{ name } }, "logo": brand.logo.asset->url }',
      ).shapes;
      expect(shape?.fields.map((f) => [f.path, f.deref])).toEqual([
        ["topic->title", true],
        ["authors[]->name", true],
        ["authors[]->org->name", true],
        ["brand.logo.asset->url", true],
      ]);
    });

    it("nested objects keep the full path, and the array that holds them is named by its elements", () => {
      const [shape] = read(
        '*[_type == "siteSettings"][0]{ title, contact{ phone, address{ street, city } }, sections[]{ heading, cta{ label } } }',
      ).shapes;
      expect(shape?.fields.map((f) => f.path)).toEqual([
        "title",
        "contact.phone",
        "contact.address.street",
        "contact.address.city",
        "sections[].heading",
        "sections[].cta.label",
      ]);
    });

    it("a spread of an array reads the array itself, a spread of the document reads nothing", () => {
      const [shape] = read('*[_type == "page"]{ ..., body[]{ ..., "n": caption } }').shapes;
      expect(shape?.fields.map((f) => f.path)).toEqual(["body", "body[].caption"]);
    });

    it("fields read inside count, coalesce, select and a conditional are fields", () => {
      const [shape] = read(
        '*[_type == "post"]{ "n": count(items), "c": coalesce(a.b, "x"), "s": select(featured == true => hero.url, thumb), ...select(kind == "x" => { extra }) }',
      ).shapes;
      expect(shape?.fields.map((f) => f.path)).toEqual([
        "items",
        "a.b",
        "featured",
        "hero.url",
        "thumb",
        "kind",
        "extra",
      ]);
    });

    it("a field read twice is listed once, in the order it was first read", () => {
      const [shape] = read(
        '*[_type == "post"]{ title, "t": title, "s": slug.current, "u": title }',
      ).shapes;
      expect(shape?.fields.map((f) => f.path)).toEqual(["title", "slug.current"]);
    });

    it("a bare filter, a count and a projection with no fields are shapes with no fields", () => {
      expect(read('count(*[_type == "post"])').shapes[0]?.fields).toEqual([]);
      expect(read('*[_type == "post"][0...3]').shapes[0]?.fields).toEqual([]);
    });

    it("a filter inside a field is a field of the array, not of the filter", () => {
      const [shape] = read('*[_type == "post"]{ "paid": prices[amount > 0].label }').shapes;
      expect(shape?.fields.map((f) => f.path)).toEqual(["prices[].label"]);
    });

    it("a query inside a projection is its own shape, with the fields it reads", () => {
      const r = read(
        '*[_type == "menuItem"][0]{ name, "related": *[_type == "menuItem" && _id != ^._id]{ title, "slug": slug.current, "parent": ^.slug } }',
      );
      expect(r.shapes.map((s) => [s.type, s.fields.map((f) => f.path)])).toEqual([
        ["menuItem", ["name", "slug"]],
        ["menuItem", ["title", "slug.current"]],
      ]);
    });

    it("an ordered, sliced query projects the same fields", () => {
      const [shape] = read(
        '*[_type == "post"] | order(publishedAt desc)[0...10]{ title, publishedAt }',
      ).shapes;
      expect(shape?.fields.map((f) => f.path)).toEqual(["title", "publishedAt"]);
    });
  });

  describe("excludesDrafts", () => {
    const drafts = (q: string) =>
      readGroq(q, { file: "q.ts", line: 1 }).shapes.map((s) => s.excludesDrafts);

    it('is true for !(_id in path("drafts.**"))', () => {
      expect(drafts('*[_type == "post" && !(_id in path("drafts.**"))]')).toEqual([true]);
      expect(drafts('*[!(_id in path("drafts.**")) && _type == "post"]')).toEqual([true]);
      expect(
        drafts('*[_type == "post" && slug.current == $s && !(_id in path("drafts.**"))][0]'),
      ).toEqual([true]);
    });

    it("is true for a match on drafts. and for a second filter that leaves them out", () => {
      expect(drafts('*[_type == "post" && !(_id match "drafts.*")]')).toEqual([true]);
      expect(drafts('*[_type == "post"][!(_id in path("drafts.**"))]')).toEqual([true]);
    });

    it("is false when the filter is _type only, or the draft test is not required of every document", () => {
      expect(drafts('*[_type == "post"]')).toEqual([false]);
      expect(drafts('*[_type == "post" && (featured || !(_id in path("drafts.**")))]')).toEqual([
        false,
      ]);
      expect(drafts('*[_type == "post" && _id in path("drafts.**")]')).toEqual([false]);
      expect(drafts('*[_type == "post" && !(_id in path("other.**"))]')).toEqual([false]);
    });
  });

  describe("types", () => {
    const types = (q: string) => readGroq(q, { file: "q.ts", line: 1 }).shapes.map((s) => s.type);

    it("two types in one filter give two shapes with the same file and line", () => {
      const r = readGroq('*[_type in ["post", "recipe"]]{ title }', { file: "q.ts", line: 7 });
      expect(r.shapes.map((s) => [s.type, s.source])).toEqual([
        ["post", { file: "q.ts", line: 7 }],
        ["recipe", { file: "q.ts", line: 7 }],
      ]);
      expect(r.shapes.map((s) => s.fields.map((f) => f.path))).toEqual([["title"], ["title"]]);
    });

    it("reads _type == and in, either way round, joined by or", () => {
      expect(types('*[_type == "a" || _type == "b"]')).toEqual(["a", "b"]);
      expect(types('*["a" == _type]')).toEqual(["a"]);
      expect(types('*[_type == "a" && _type in ["a", "b"]]')).toEqual(["a"]);
    });

    it("an or with a branch that is not a type pins nothing", () => {
      expect(readGroq('*[_type == "a" || featured]', { file: "q.ts", line: 1 }).unreadable).toEqual(
        [{ reason: "no-type-filter", source: { file: "q.ts", line: 1 } }],
      );
    });
  });
});

describe("extractGroq: edge cases", () => {
  it("a template with one interpolation is reported as concatenated, with its file and line", async () => {
    const dir = tree({
      "lib/search.ts":
        '// 1\n// 2\nexport const q = (t: string) =>\n  groq`*[_type == "post" && title match ${t}]`;\n',
    });
    const r = await extractGroq(dir);
    expect(r.queries).toEqual([]);
    expect(r.unreadable).toEqual([
      { reason: "concatenated", source: { file: "lib/search.ts", line: 4 } },
    ]);
  });

  it("a string built with + or taken from a variable is concatenated too, never guessed", async () => {
    const dir = tree({
      "a.ts":
        'const part = "x";\nexport const q = defineQuery("*[_type == \\"post\\"" + part + "]");\nexport const r = defineQuery(part);\nexport const s = defineQuery(`*[_type == "${part}"]`);\n',
    });
    const r = await extractGroq(dir);
    expect(r.unreadable.map((u) => [u.reason, u.source.line])).toEqual([
      ["concatenated", 2],
      ["concatenated", 3],
      ["concatenated", 4],
    ]);
  });

  it("a query with parameters parses and lists them, sorted, without the $", async () => {
    const dir = tree({
      "a.ts":
        'export const q = groq`*[_type == "post" && slug.current == $slug && lang == $lang][0]{ title, "mine": $user }`;\n',
    });
    const r = await extractGroq(dir);
    expect(r.queries[0]?.params).toEqual(["lang", "slug", "user"]);
  });

  it("a file with a syntax error is reported once, with its line, and the walk continues", async () => {
    const dir = tree({
      "a.ts": 'export const ok = groq`*[_type == "post"]{ title }`;\n',
      "b.ts":
        'export const q = groq`*[_type == "page"]{ title }`;\n\nexport function broken( {\n  return 1;\n}\n',
      "c.ts": 'export const ok = groq`*[_type == "tag"]{ title }`;\n',
    });
    const r = await extractGroq(dir);
    expect(r.queries.map((q) => q.type)).toEqual(["post", "tag"]);
    expect(r.unreadable).toHaveLength(1);
    expect(r.unreadable[0]).toMatchObject({ reason: "parse-error", source: { file: "b.ts" } });
    expect(r.unreadable[0]?.source.line).toBeGreaterThanOrEqual(3);
  });

  it("a string that is not GROQ is a parse-error at its own line, and the next query is still read", async () => {
    const dir = tree({
      "a.ts":
        'export const bad = groq`*[_type == "post"`;\nexport const worse = groq`*[_type == "x"]{ a.b }`;\nexport const ok = groq`*[_type == "tag"]`;\n',
    });
    const r = await extractGroq(dir);
    expect(r.queries.map((q) => q.type)).toEqual(["tag"]);
    expect(r.unreadable.map((u) => [u.reason, u.source.line])).toEqual([
      ["parse-error", 1],
      ["parse-error", 2],
    ]);
  });

  it("a query with no _type filter is no-type-filter, once, even when it has several sets", async () => {
    const dir = tree({
      "a.ts":
        'export const q = groq`*[_id == $id][0]{ title }`;\nexport const r = groq`{ "a": *[title == "x"], "b": *[slug == "y"] }`;\n',
    });
    const r = await extractGroq(dir);
    expect(r.queries).toEqual([]);
    expect(r.unreadable.map((u) => [u.reason, u.source.line])).toEqual([
      ["no-type-filter", 1],
      ["no-type-filter", 2],
    ]);
  });

  it("a query with a typed set and an untyped one gives the shape and reports the other", async () => {
    const dir = tree({
      "a.ts":
        'export const q = groq`*[_type == "post"][0]{ title, "ref": *[_id == ^.ref._ref][0].title }`;\n',
    });
    const r = await extractGroq(dir);
    expect(r.queries.map((q) => q.type)).toEqual(["post"]);
    expect(r.unreadable.map((u) => u.reason)).toEqual(["no-type-filter"]);
  });

  it("Windows line endings give the same line numbers as Unix ones", async () => {
    const text =
      'import groq from "groq";\n\n// a comment\nexport const a = groq`*[_type == "post"]{\n  title\n}`;\n\nexport const b = defineQuery(\n  "*[_type == \\"page\\"]",\n);\nexport const c = groq`*[_type == "x" && ${y}]`;\n';
    const unix = await extractGroq(tree({ "a.ts": text }));
    const windows = await extractGroq(tree({ "a.ts": text.replace(/\n/g, "\r\n") }));
    expect(unix.queries.map((q) => q.source.line)).toEqual([4, 9]);
    expect(unix.unreadable.map((q) => q.source.line)).toEqual([11]);
    expect(windows).toEqual(unix);
  });

  it("a byte order mark at the start of a file changes nothing", async () => {
    const text = 'export const q = groq`*[_type == "post"]{ title }`;\n';
    const a = await extractGroq(tree({ "a.ts": text }));
    const b = await extractGroq(tree({ "a.ts": `${String.fromCharCode(0xfeff)}${text}` }));
    expect(b).toEqual(a);
  });

  it("skips node_modules, .next, dist and .git, at any depth", async () => {
    const q = 'export const q = groq`*[_type == "x"]{ a }`;\n';
    const dir = tree({
      "node_modules/pkg/index.js": q,
      "app/node_modules/pkg/index.js": q,
      ".next/server/page.js": q,
      "dist/index.js": q,
      "packages/web/dist/index.js": q,
      ".git/hooks/x.js": q,
      "src/real.ts": q,
    });
    const r = await extractGroq(dir);
    expect(r.queries.map((x) => x.source.file)).toEqual(["src/real.ts"]);
  });

  it("skips what .gitignore names, including a nested .gitignore and a ! that takes a file back", async () => {
    const q = 'export const q = groq`*[_type == "x"]{ a }`;\n';
    const dir = tree({
      ".gitignore": "# comment\n\ngenerated/\n*.gen.ts\n/scratch.ts\n!keep.gen.ts\n",
      "generated/a.ts": q,
      "src/generated/b.ts": q,
      "src/x.gen.ts": q,
      "src/keep.gen.ts": q,
      "scratch.ts": q,
      "src/scratch.ts": q,
      "src/.gitignore": "local.ts\n",
      "src/local.ts": q,
      "src/deep/local.ts": q,
      "other/local.ts": q,
      "src/kept.ts": q,
    });
    const r = await extractGroq(dir);
    expect(r.queries.map((x) => x.source.file)).toEqual([
      "other/local.ts",
      "src/keep.gen.ts",
      "src/kept.ts",
      "src/scratch.ts",
    ]);
  });

  it("does not follow a link out of the folder", async () => {
    const outside = tree({ "secret.ts": 'export const q = groq`*[_type == "x"]{ a }`;\n' });
    const dir = tree({ "src/a.ts": 'export const q = groq`*[_type == "y"]{ a }`;\n' });
    try {
      symlinkSync(outside, join(dir, "linked"), "dir");
    } catch {
      return; // A system that does not let this account make links (Windows without privilege).
    }
    const r = await extractGroq(dir);
    expect(r.queries.map((x) => x.type)).toEqual(["y"]);
  });

  it("an empty folder is no queries and no unreadable", async () => {
    expect(await extractGroq(tree({}))).toEqual({ queries: [], unreadable: [] });
  });

  it("a folder that does not exist, or is a file, is a ConfigError that says so", async () => {
    const dir = tree({ "a.ts": "export {};\n" });
    await expect(extractGroq(join(dir, "missing"))).rejects.toThrow(ConfigError);
    await expect(extractGroq(join(dir, "missing"))).rejects.toThrow(/does not exist/);
    await expect(extractGroq(join(dir, "a.ts"))).rejects.toThrow(/is a file, not a folder/);
  });

  it("when TypeScript is not installed the error says how to get it", async () => {
    const dir = tree({ "a.ts": "export {};\n" });
    const error = await extractGroq(dir, {
      loadTypeScript: () => Promise.reject(new Error("Cannot find package 'typescript'")),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).hint).toContain("npx -p gaugeline -p typescript");
  });

  it("the result is the same on every run, whatever order the system lists files in", async () => {
    const files: Record<string, string> = {};
    for (const n of ["b", "a", "c", "B", "a/z", "a/b"])
      files[`${n}.ts`] = `export const q = groq\`*[_type == "${n.replace("/", "_")}"]\`;\n`;
    const dir = tree(files);
    const first = await extractGroq(dir);
    expect(await extractGroq(dir)).toEqual(first);
    expect(first.queries.map((q) => q.source.file)).toEqual(
      [...first.queries.map((q) => q.source.file)].sort(),
    );
  });
});

describe("extractGroq: integration (fixtures/repo-groq)", () => {
  const repo = fileURLToPath(new URL("../../../../fixtures/repo-groq/", import.meta.url));
  const expectedFile = fileURLToPath(new URL("./repo-groq.expected.json", import.meta.url));

  it("12 queries, 2 unreadable: the JSON matches the snapshot", async () => {
    const r = await extractGroq(repo);
    // UPDATE_SNAPSHOT=1 rewrites the file; run prettier on it after.
    if (process.env.UPDATE_SNAPSHOT) writeFileSync(expectedFile, `${JSON.stringify(r, null, 2)}\n`);
    expect(r).toEqual(JSON.parse(readFileSync(expectedFile, "utf8")));
    expect(r.queries).toHaveLength(12);
    expect(r.unreadable).toHaveLength(2);
  });

  it("the fixture covers the field forms the spec names", async () => {
    const r = await extractGroq(repo);
    expect(paths(r, "category")).toBeUndefined();
    expect(
      r.queries
        .find((q) => q.type === "popup" && q.source.file.endsWith("events/page.tsx"))
        ?.fields.map((f) => f.path),
    ).toEqual(["title", "date", "venue->name", "venue->address.city"]);
    expect(r.queries.find((q) => q.type === "siteSettings")?.fields.map((f) => f.path)).toContain(
      "contact.address.city",
    );
  });
});

describe("extractGroq: promises", () => {
  it("sends nothing: any attempt to open a connection throws, and it still reads the repository", async () => {
    const http = await import("node:http");
    const https = await import("node:https");
    const net = await import("node:net");
    const boom = () => {
      throw new Error("a request was made");
    };
    const spies = [
      vi.spyOn(http.default, "request").mockImplementation(boom),
      vi.spyOn(http.default, "get").mockImplementation(boom),
      vi.spyOn(https.default, "request").mockImplementation(boom),
      vi.spyOn(https.default, "get").mockImplementation(boom),
      vi.spyOn(net.default, "connect").mockImplementation(boom),
      vi.spyOn(globalThis, "fetch").mockImplementation(boom),
    ];
    try {
      const repo = fileURLToPath(new URL("../../../../fixtures/repo-groq/", import.meta.url));
      const r = await extractGroq(repo);
      expect(r.queries).toHaveLength(12);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
