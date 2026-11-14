import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, parse } from "groq-js";
import { describe, expect, it } from "vitest";
import {
  CONTENT_MARKER,
  NORTHFIELD_CONTENT,
  northfieldResources,
  sanityCountsTransport,
  type FakeSanity,
} from "../../../../testkit/src/index.js";
import { createSanityRead } from "../../connectors/sanity.js";
import { createFetcher } from "../../fetcher.js";
import { compareWithCounts, fetchCounts } from "../counts.js";
import { readContentShape, type ContentShape, type FieldShape } from "../content-shape.js";
import { extractGroq } from "../extract.js";
import { readSchemaFileFull } from "../mutations.js";
import { scaffoldRoute, type GeneratedFile } from "../scaffold.js";
import { importTypeScript } from "../source.js";

const f = (
  name: string,
  kind: FieldShape["kind"],
  present: number,
  more: Partial<FieldShape> = {},
): FieldShape => ({ name, kind, present, ...more });

/** The 12-document resource shape from docs/query-check.md, as readContentShape gives it. */
const RESOURCE: ContentShape = {
  type: "resource",
  sampled: 12,
  fields: [
    f("title", "string", 12),
    f("slug", "slug", 12),
    f("summary", "string", 12),
    f("topic", "reference", 12),
    f("body", "portable-text", 12),
    f("heroImage", "image", 12, { instances: 12 }),
    f("tags", "array", 12, { item: "string" }),
    f("publishedAt", "string", 6),
    f("gatedFile", "file", 4),
  ],
};

const shaped = (fields: FieldShape[], type = "resource", sampled = 12): ContentShape => ({
  type,
  sampled,
  fields,
});

const text = (files: GeneratedFile[], name: GeneratedFile["name"]): string =>
  files.find((x) => x.name === name)?.text ?? "";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = resolve(here, "../../../../fixtures/repo-gql/schema.json");
const PROJECT = resolve(here, "../../../../fixtures/repo-page");
const ENV = { SANITY_PROJECT_ID: "northfield", SANITY_DATASET: "production" };

describe("scaffoldRoute: unit", () => {
  it("writes three files, in the order queries, types, page", () => {
    expect(scaffoldRoute(RESOURCE).map((x) => x.name)).toEqual([
      "queries.ts",
      "types.ts",
      "page.tsx",
    ]);
  });

  it("the resource shape gives these three files (snapshot)", async () => {
    const files = scaffoldRoute(RESOURCE);
    for (const x of files)
      await expect(x.text).toMatchFileSnapshot(`./scaffold/resource.${x.name}.txt`);
  });

  it("the same shape gives the same text, and the shape is not changed", () => {
    const shape = structuredClone(RESOURCE);
    const first = scaffoldRoute(shape);
    expect(shape).toEqual(RESOURCE);
    expect(scaffoldRoute(structuredClone(RESOURCE))).toEqual(first);
  });

  it("types.ts: publishedAt (50%) is optional and title (100%) is required", () => {
    const types = text(scaffoldRoute(RESOURCE), "types.ts");
    expect(types).toMatch(/^ {2}publishedAt\?: string;/m);
    expect(types).toMatch(/^ {2}title: string;$/m);
    expect(types).toMatch(/^ {2}gatedFile\?: \{ url: string \| null;/m);
    expect(types.match(/export interface /g)).toHaveLength(1);
  });

  it("types.ts: a reference, an image and a file can be null, Portable Text is an array of blocks", () => {
    const types = text(scaffoldRoute(RESOURCE), "types.ts");
    expect(types).toContain(
      "topic: { _id: string; title: string | null; slug: string | null } | null;",
    );
    expect(types).toMatch(
      /heroImage: \{\n {4}url: string \| null;\n {4}alt: string;\n {4}width: number \| null;\n {4}height: number \| null;\n {2}\} \| null;/,
    );
    expect(types).toContain("body: PortableTextBlock[];");
    expect(types).toContain('import type { PortableTextBlock } from "@portabletext/react";');
    expect(types).toContain("tags: string[];");
  });

  it("types.ts: a nested field is optional against its parent, not the document count", () => {
    const types = text(
      scaffoldRoute(
        shaped([
          f("title", "string", 12),
          f("seo", "object", 12, {
            instances: 12,
            of: [f("title", "string", 12), f("note", "string", 3)],
          }),
        ]),
      ),
      "types.ts",
    );
    expect(types).toContain("seo: { title: string; note?: string } | null;");
  });

  it("page.tsx: generateStaticParams, generateMetadata, a canonical, width and height on the image, alt from the field", () => {
    const page = text(scaffoldRoute(RESOURCE), "page.tsx");
    expect(page).toContain("export async function generateStaticParams()");
    expect(page).toContain("export async function generateMetadata(");
    expect(page).toContain("alternates: { canonical: path }");
    expect(page).toContain('openGraph: { type: "article", url: path, title, description, images }');
    expect(page).toContain('twitter: { card: images ? "summary_large_image" : "summary"');
    expect(page).toContain("alt={doc.heroImage.alt}");
    expect(page).toContain("width={doc.heroImage.width}");
    expect(page).toContain("height={doc.heroImage.height}");
    expect(page).toContain("<PortableText value={doc.body} />");
    expect(page).toContain("<Link href={`/topic/${doc.topic.slug}`}>");
    expect(page).toContain("const { slug } = await params;");
  });

  it("queries.ts: list, slugs and detail queries, drafts out of each, and the image's own size", () => {
    const q = text(scaffoldRoute(RESOURCE), "queries.ts");
    for (const name of ["resourceListQuery", "resourceSlugsQuery", "resourceQuery"])
      expect(q).toContain(`export const ${name} = groq\``);
    expect(q.match(/!\(_id in path\("drafts\.\*\*"\)\)/g)).toHaveLength(3);
    expect(q).toContain("slug.current == $slug");
    expect(q).toContain('"width": asset->metadata.dimensions.width');
    expect(q).toContain('"height": asset->metadata.dimensions.height');
    expect(q).toContain('import groq from "groq";');
  });

  it("only fields that exist on the documents: one on none is left out of all three files", () => {
    const files = scaffoldRoute(
      shaped([f("title", "string", 12), f("slug", "slug", 12), f("ghost", "string", 0)]),
    );
    for (const x of files) expect(x.text).not.toMatch(/ghost(?!.*left out)/);
    expect(text(files, "queries.ts")).toContain(
      "// ghost is in the schema and on none of the sample",
    );
  });

  it("a type with no image field has no image block, no image import and no share image", () => {
    const files = scaffoldRoute(
      shaped([f("title", "string", 12), f("slug", "slug", 12), f("summary", "string", 12)]),
    );
    const page = text(files, "page.tsx");
    expect(page).not.toContain("next/image");
    expect(page).not.toMatch(/width=|height=|images|<Image/);
    expect(page).toContain('twitter: { card: "summary", title, description }');
    expect(text(files, "queries.ts")).not.toContain("metadata.dimensions");
    expect(text(files, "types.ts")).not.toContain("width");
  });

  it("no Portable Text and no reference means neither import is written", () => {
    const page = text(
      scaffoldRoute(shaped([f("title", "string", 12), f("slug", "slug", 12)])),
      "page.tsx",
    );
    expect(page).not.toContain("@portabletext/react");
    expect(page).not.toContain("next/link");
    expect(text(scaffoldRoute(shaped([f("title", "string", 12)])), "types.ts")).not.toContain(
      "import",
    );
  });

  it("a type without a slug field makes the address from the document id and says so", () => {
    const files = scaffoldRoute(shaped([f("title", "string", 12)]));
    expect(text(files, "queries.ts")).toContain("_id == $slug");
    expect(text(files, "queries.ts")).toContain("]._id`;");
    expect(text(files, "queries.ts")).toContain("has no slug field");
    expect(text(files, "page.tsx")).toContain("<h1>{doc.title}</h1>");
  });

  it("a slug field with another name makes the address; a type with no title uses the address as its heading", () => {
    const files = scaffoldRoute(shaped([f("handle", "slug", 12), f("blurb", "string", 12)]));
    expect(text(files, "queries.ts")).toContain("handle.current == $slug");
    expect(text(files, "page.tsx")).toContain("<h1>{slug}</h1>");
  });

  it("an optional title falls back to the address, an optional description to undefined", () => {
    const page = text(
      scaffoldRoute(shaped([f("title", "string", 6), f("summary", "string", 6)])),
      "page.tsx",
    );
    expect(page).toContain("const title = doc.title || slug;");
    expect(page).toContain("const description = doc.summary || undefined;");
  });

  it("a list of references is linked, a list of objects and a mixed field are left for the user", () => {
    const page = text(
      scaffoldRoute(
        shaped([
          f("title", "string", 12),
          f("related", "array", 12, { item: "reference" }),
          f("sections", "array", 12, { item: "object" }),
          f("credit", "string", 12, { mixed: ["string", "object"] }),
          f("seo", "object", 12),
        ]),
      ),
      "page.tsx",
    );
    expect(page).toContain("{doc.related.map((item) =>");
    expect(page).toContain("<Link href={`/related/${item.slug}`}>");
    expect(page).toContain("{/* sections is a list of objects: write how it should look. */}");
    expect(page).toContain("{/* credit can be more than one kind: write how it should look. */}");
    expect(page).toContain("{/* seo is an object: write how it should look. */}");
  });

  it("an optional list is guarded, an optional number and boolean are shown when set", () => {
    const page = text(
      scaffoldRoute(
        shaped([
          f("tags", "array", 6, { item: "string" }),
          f("price", "number", 6),
          f("featured", "boolean", 6),
        ]),
      ),
      "page.tsx",
    );
    expect(page).toContain("{(doc.tags ?? []).map((item, i) => (");
    expect(page).toContain("{doc.price !== undefined ? <p>{String(doc.price)}</p> : null}");
    expect(page).toContain("{doc.featured !== undefined ? <p>{String(doc.featured)}</p> : null}");
  });

  it("the interface is named from the type, and never as something the files already use", () => {
    const named = (type: string): string =>
      /export interface (\w+)/.exec(
        text(scaffoldRoute(shaped([f("title", "string", 3)], type, 3)), "types.ts"),
      )?.[1] ?? "";
    expect(named("resource")).toBe("Resource");
    expect(named("blog-post")).toBe("BlogPost");
    expect(named("blog_post")).toBe("BlogPost");
    expect(named("image")).toBe("ImageDocument");
    expect(named("Link")).toBe("LinkDocument");
    expect(named("Date")).toBe("DateDocument");
    const files = scaffoldRoute(shaped([f("title", "string", 3)], "blog-post", 3));
    expect(text(files, "queries.ts")).toContain("export const blogPostQuery = groq`");
    expect(text(files, "page.tsx")).toContain("export default async function BlogPostPage(");
    expect(text(files, "page.tsx")).toContain('const BASE_PATH = "/blog-post";');
  });

  it("a name that is not a plain identifier is refused before it is placed in code", () => {
    for (const bad of ['a" || true //', "x`${process.exit(1)}`", "two words", "a-b", "", "1a"])
      expect(() => scaffoldRoute(shaped([f(bad, "string", 12)]))).toThrow(/cannot be written/);
    expect(() =>
      scaffoldRoute(
        shaped([
          f("seo", "object", 12, { instances: 12, of: [f("a'; alert(1); '", "string", 12)] }),
        ]),
      ),
    ).toThrow(/cannot be written/);
    for (const bad of ['resource"; drop', "a b", "", "x".repeat(65), "`${x}`"])
      expect(() => scaffoldRoute(shaped([f("title", "string", 12)], bad))).toThrow(
        /not a Sanity document type name/,
      );
  });

  it("a type with no published documents is refused, not scaffolded from nothing", () => {
    expect(() => scaffoldRoute({ type: "topic", sampled: 0, fields: [] })).toThrow(
      /Nothing of type topic exists/,
    );
  });

  it("scaffold.ts reads and writes nothing: it imports no node module and no fetcher", () => {
    const source = readFileSync(resolve(here, "../scaffold.ts"), "utf8");
    const specs = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec).not.toMatch(/^node:|^fs|^path|fetcher|transport|^undici/);
    }
    expect(source).not.toMatch(/\bprocess\b|\bfetch\s*\(|writeFile|readFile/);
  });
});

// ---------------------------------------------------------------------------------------------
// Integration: the generated files against a project, against the parser, against the dataset
// ---------------------------------------------------------------------------------------------

function readerFor(spec: FakeSanity) {
  return createSanityRead(
    ENV,
    createFetcher({ transport: sanityCountsTransport(spec, []), timeoutMs: 5000 }),
  );
}

async function northfieldShape(spec: FakeSanity = NORTHFIELD_CONTENT): Promise<ContentShape> {
  return readContentShape("resource", readerFor(spec), await readSchemaFileFull(SCHEMA_FILE));
}

/** Every optional field filled in, so the counts have nothing to say. */
const FILLED: FakeSanity = {
  types: { resource: { total: 12 } },
  content: {
    resource: northfieldResources().map((d) => ({
      ...d,
      publishedAt: "2026-01-01T00:00:00Z",
      gatedFile: {
        _type: "file",
        asset: { _type: "reference", _ref: `file-${CONTENT_MARKER}-pdf` },
      },
      heroImage: {
        _type: "image",
        alt: `${CONTENT_MARKER} alt`,
        asset: { _type: "reference", _ref: `image-${CONTENT_MARKER}-800x600-jpg` },
      },
    })),
    topic: [],
  },
};

/** What the dataset says about how many resources have each optional field: the same numbers as the documents. */
const COUNTED: FakeSanity = {
  ...NORTHFIELD_CONTENT,
  types: {
    resource: { total: 12, defined: { publishedAt: 6, "gatedFile.asset": 4, "heroImage.alt": 6 } },
  },
};

describe("scaffoldRoute: integration (real shapes, a project, the parser)", () => {
  it("the shape read from the schema and the counts gives the same files as the hand-written one", async () => {
    const read = scaffoldRoute(await northfieldShape());
    const written = scaffoldRoute({
      ...RESOURCE,
      fields: RESOURCE.fields.map((x) => (x.name === "heroImage" ? { ...x, of: undefined } : x)),
    });
    expect(read.map((x) => x.text)).toEqual(written.map((x) => x.text));
  });

  it("the three files type-check with tsc --noEmit inside the fixture Next.js project", async () => {
    const ts = await importTypeScript();
    const temp = mkdtempSync(join(tmpdir(), "gaugeline-scaffold-"));
    try {
      cpSync(PROJECT, temp, { recursive: true });
      const routes: Record<string, ContentShape> = {
        resource: await northfieldShape(),
        minimal: shaped([f("title", "string", 3)], "note", 3),
        rich: shaped(
          [
            f("name", "string", 20),
            f("handle", "slug", 20),
            f("excerpt", "string", 10),
            f("price", "number", 15),
            f("featured", "boolean", 5),
            f("body", "portable-text", 20),
            f("author", "reference", 20),
            f("related", "array", 18, { item: "reference" }),
            f("cover", "image", 20, {
              instances: 20,
              of: [
                f("caption", "string", 4),
                f("credit", "object", 2, {
                  instances: 2,
                  of: [f("name", "string", 2)],
                }),
              ],
            }),
            f("gallery", "array", 9, {
              item: "image",
              instances: 30,
              of: [f("caption", "string", 10)],
            }),
            f("brochure", "file", 3),
            f("tags", "array", 20, { item: "string" }),
            f("scores", "array", 2, { item: "number" }),
            f("sections", "array", 20, {
              item: "object",
              instances: 60,
              of: [f("heading", "string", 60), f("note", "string", 5)],
            }),
            f("seo", "object", 8, { instances: 8, of: [f("title", "string", 8)] }),
            f("mixed", "string", 20, { mixed: ["string", "object"] }),
            f("loose", "array", 20, { itemsMixed: ["string", "object"] }),
            f("class", "string", 20),
            f("delete", "string", 20),
          ],
          "blog-post",
          20,
        ),
      };
      for (const [dir, shape] of Object.entries(routes)) {
        const target = join(temp, "src", "app", dir, "[slug]");
        mkdirSync(target, { recursive: true });
        for (const file of scaffoldRoute(shape)) writeFileSync(join(target, file.name), file.text);
      }
      const diagnose = (): string[] => {
        const config = ts.readConfigFile(join(temp, "tsconfig.json"), ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, temp);
        const program = ts.createProgram(parsed.fileNames, parsed.options);
        return ts
          .getPreEmitDiagnostics(program)
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      };
      expect(diagnose()).toEqual([]);

      // The stand-ins are strict: a page without the image's alt text does not compile.
      const page = join(temp, "src", "app", "resource", "[slug]", "page.tsx");
      writeFileSync(page, readFileSync(page, "utf8").replace("alt={doc.heroImage.alt}", ""));
      expect(diagnose().join("\n")).toMatch(/alt/);
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60_000);

  it("the queries are read by the parser from G27: three queries of the type, none unreadable", async () => {
    const temp = mkdtempSync(join(tmpdir(), "gaugeline-scaffold-"));
    try {
      const files = scaffoldRoute(await northfieldShape());
      writeFileSync(join(temp, "queries.ts"), text(files, "queries.ts"));
      const found = await extractGroq(temp);
      expect(found.unreadable).toEqual([]);
      expect(found.queries.map((q) => q.type)).toEqual(["resource", "resource", "resource"]);
      expect(found.queries.every((q) => q.excludesDrafts)).toBe(true);
      expect(found.queries[2]?.params).toEqual(["slug"]);
      for (const q of text(files, "queries.ts").matchAll(/groq`([^`]*)`/g))
        expect(() => parse(q[1] ?? "")).not.toThrow();
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("against the recorded dataset the queries pass the content counts with no finding when every field is filled in", async () => {
    const temp = mkdtempSync(join(tmpdir(), "gaugeline-scaffold-"));
    try {
      const files = scaffoldRoute(await northfieldShape(FILLED));
      writeFileSync(join(temp, "queries.ts"), text(files, "queries.ts"));
      const { queries } = await extractGroq(temp);
      const read = readerFor(FILLED);
      const counts = await fetchCounts(queries, read);
      expect(compareWithCounts(queries, counts)).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("against the Northfield dataset the only findings are the optional fields, all low, and none is high or about drafts", async () => {
    const temp = mkdtempSync(join(tmpdir(), "gaugeline-scaffold-"));
    try {
      const shape = await northfieldShape();
      const files = scaffoldRoute(shape);
      writeFileSync(join(temp, "queries.ts"), text(files, "queries.ts"));
      const { queries } = await extractGroq(temp);
      const found = compareWithCounts(queries, await fetchCounts(queries, readerFor(COUNTED)));
      expect(found.every((x) => x.checkId === "query-field-partial" && x.severity === "low")).toBe(
        true,
      );
      const named = new Set(
        found.map((x) => /(\S+) is missing on/.exec(x.evidence)?.[1] ?? x.evidence),
      );
      // The optional fields types.ts marks (a file is counted at its asset), and the image's alt, which is always written with a default.
      expect([...named].sort()).toEqual(["gatedFile.asset", "heroImage.alt", "publishedAt"]);
      const optional = [...text(files, "types.ts").matchAll(/^ {2}(\w+)\?:/gm)].map((m) => m[1]);
      expect(optional.sort()).toEqual(["gatedFile", "publishedAt"]);
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("run over the dataset the queries give the documents types.ts describes: published only, newest first, every required key present", async () => {
    const shape = await northfieldShape();
    const files = scaffoldRoute(shape);
    const queries = new Map(
      [...text(files, "queries.ts").matchAll(/export const (\w+) = groq`([^`]*)`/g)].map((m) => [
        m[1] ?? "",
        m[2] ?? "",
      ]),
    );
    const dataset = Object.values(NORTHFIELD_CONTENT.content ?? {}).flat();
    const run = async (name: string, params: Record<string, unknown> = {}): Promise<unknown> =>
      (await evaluate(parse(queries.get(name) ?? ""), { dataset, params })).get();

    const list = (await run("resourceListQuery")) as Record<string, unknown>[];
    expect(list).toHaveLength(12);
    expect(list.map((x) => x._id)[0]).toBe("resource-01");
    expect(Object.keys(list[0] ?? {})).toEqual(["_id", "title", "slug", "summary", "heroImage"]);

    const slugs = (await run("resourceSlugsQuery")) as string[];
    expect(slugs).toHaveLength(12);
    expect(slugs[0]).toBe(`${CONTENT_MARKER.toLowerCase()}-slug-01`);

    const detail = (await run("resourceQuery", { slug: slugs[0] })) as Record<string, unknown>;
    const types = text(files, "types.ts");
    const required = [...types.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
    for (const key of required) expect(detail, key).toHaveProperty(key ?? "");
    // An optional field is written with a default, never null: resource-07 has no publishedAt.
    expect(typeof detail.publishedAt).toBe("string");
    const seventh = (await run("resourceQuery", { slug: slugs[6] })) as Record<string, unknown>;
    expect(seventh.publishedAt).toBe("");
    expect(seventh.gatedFile).toBeNull();
    expect(await run("resourceQuery", { slug: "no-such-slug" })).toBeNull();
    // A draft is never returned, though a draft of resource-01 exists.
    expect(list.some((x) => String(x._id).startsWith("drafts."))).toBe(false);
  });

  it("no document value reaches a generated file: the marker the dataset puts on every text is nowhere in them", async () => {
    const files = scaffoldRoute(await northfieldShape());
    for (const x of files) expect(x.text).not.toContain(CONTENT_MARKER);
  });
});
