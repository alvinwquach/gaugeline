import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../errors.js";
import {
  MUTATION_TITLES,
  checkMutations,
  extractMutations,
  readMutations,
  readSchema,
  readSchemaFile,
  type MutationShape,
  type SchemaShape,
} from "../mutations.js";

const made: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of made.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A folder holding these files (paths with `/`), and its path. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-mut-"));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const full = join(dir, ...name.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

/** A source file that imports nothing and has one function body. */
const file = (body: string): string => `export async function run(id: string) {\n${body}\n}\n`;
/** The same, with no type annotation, for the .js, .jsx and .mjs files. */
const plain = (body: string): string => `export async function run(id) {\n${body}\n}\n`;

const field = (required = false, reference = false) => ({ required, reference });

/** Two types: resource (title required, owner a required reference, status, summary) and topic. */
const SCHEMA: SchemaShape = new Map([
  [
    "resource",
    new Map([
      ["title", field(true)],
      ["owner", field(true, true)],
      ["status", field()],
      ["summary", field()],
    ]),
  ],
  ["topic", new Map([["name", field(true)]])],
]);

const kinds = (shapes: MutationShape[]) => shapes.map((s) => s.kind);
const sets = (s: MutationShape | undefined) => [...(s?.sets ?? [])];

describe("extractMutations: unit", () => {
  it("client.patch(id).set({...}) is a patch with the written fields and the kind of each value", async () => {
    const dir = tree({
      "a.ts": file(
        '  await client.patch(id).set({ status: "live", owner: { _type: "reference", _ref: id }, count: 3 }).commit();',
      ),
    });
    const shapes = await extractMutations(dir);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.kind).toBe("patch");
    expect(sets(shapes[0])).toEqual([
      ["status", "string"],
      ["owner", "ref"],
      ["count", "other"],
    ]);
    expect(shapes[0]?.source).toEqual({ file: "a.ts", line: 2 });
    expect(shapes[0]?.touchesDrafts).toBe(false);
    expect(shapes[0]?.type).toBeUndefined();
  });

  it("client.create({...}) is a create with its _type, and createOrReplace and createIfNotExists likewise", async () => {
    const dir = tree({
      "a.ts": file(
        [
          '  await client.create({ _type: "resource", title: "A", owner: { _ref: id } });',
          '  await client.createOrReplace({ _id: id, _type: "topic", name: `T${id}` });',
          '  await client.createIfNotExists({ _id: id, _type: "topic", name: "x" });',
        ].join("\n"),
      ),
    });
    const shapes = await extractMutations(dir);
    expect(kinds(shapes)).toEqual(["create", "createOrReplace", "createIfNotExists"]);
    expect(shapes.map((s) => s.type)).toEqual(["resource", "topic", "topic"]);
    expect(sets(shapes[0])).toEqual([
      ["title", "string"],
      ["owner", "ref"],
    ]);
    expect(sets(shapes[1])).toEqual([
      ["_id", "other"],
      ["name", "string"],
    ]);
  });

  it("a transaction chain with three operations is one transaction holding all three", async () => {
    const dir = tree({
      "a.ts": file(
        [
          "  await client",
          "    .transaction()",
          '    .create({ _type: "topic", name: "T" })',
          '    .patch(id, { set: { status: "live" }, unset: ["summary"] })',
          "    .delete(id)",
          "    .commit();",
        ].join("\n"),
      ),
    });
    const shapes = await extractMutations(dir);
    expect(shapes).toHaveLength(1);
    const tx = shapes[0];
    expect(tx?.kind).toBe("transaction");
    expect(kinds(tx?.ops ?? [])).toEqual(["create", "patch", "delete"]);
    expect(sets(tx?.ops?.[1])).toEqual([
      ["status", "string"],
      ["summary", "other"],
    ]);
    expect(tx?.source.line).toBe(3);
    // The transaction's own sets are every field its operations write.
    expect([...(tx?.sets.keys() ?? [])]).toEqual(["name", "status", "summary"]);
  });

  it("a patch inside a transaction can use the builder form: patch(id, (p) => p.set({...}).inc({...}))", async () => {
    const dir = tree({
      "a.ts": file(
        '  await client.transaction().patch(id, (p) => p.set({ status: "live" }).inc({ views: 1 })).commit();',
      ),
    });
    const tx = (await extractMutations(dir))[0];
    expect(sets(tx?.ops?.[0])).toEqual([
      ["status", "string"],
      ["views", "other"],
    ]);
  });

  it("a transaction kept in a variable collects the calls made on it", async () => {
    const dir = tree({
      "a.ts": file(
        [
          "  const tx = client.transaction();",
          '  tx.create({ _type: "topic", name: "T" });',
          '  tx.patch(id).set({ status: "live" });',
          "  await tx.commit();",
        ].join("\n"),
      ),
    });
    const shapes = await extractMutations(dir);
    expect(kinds(shapes)).toEqual(["transaction"]);
    expect(kinds(shapes[0]?.ops ?? [])).toEqual(["create", "patch"]);
  });

  it("a raw mutations array (client.mutate, or a mutations key in a request body) is a transaction of what it names", async () => {
    const dir = tree({
      "a.ts": file(
        [
          "  await client.mutate([",
          '    { create: { _type: "topic", name: "T" } },',
          '    { patch: { id, set: { status: "live" } } },',
          "    { delete: { id } },",
          "  ]);",
        ].join("\n"),
      ),
      "b.ts": file(
        [
          '  await fetch("https://example.test/mutate", {',
          "    method: 'POST',",
          '    body: JSON.stringify({ mutations: [{ createOrReplace: { _id: id, _type: "topic", name: "x" } }] }),',
          "  });",
        ].join("\n"),
      ),
    });
    const shapes = await extractMutations(dir);
    expect(shapes.map((s) => [s.source.file, s.kind])).toEqual([
      ["a.ts", "transaction"],
      ["b.ts", "transaction"],
    ]);
    expect(kinds(shapes[0]?.ops ?? [])).toEqual(["create", "patch", "delete"]);
    expect(shapes[0]?.ops?.[0]?.type).toBe("topic");
    expect(sets(shapes[0]?.ops?.[1])).toEqual([["status", "string"]]);
    expect(kinds(shapes[1]?.ops ?? [])).toEqual(["createOrReplace"]);
  });

  it("an array kept in a const is read where it is passed, and only once", async () => {
    const dir = tree({
      "a.ts": file(
        [
          '  const ops = [{ create: { _type: "topic", name: "T" } }];',
          "  await client.mutate(ops);",
          "  return JSON.stringify({ mutations: ops });",
        ].join("\n"),
      ),
    });
    expect(kinds(await extractMutations(dir))).toEqual(["transaction"]);
  });

  it("setIfMissing, unset, inc, dec, append, prepend and insert each write the field they name", async () => {
    const dir = tree({
      "a.ts": file(
        [
          "  await client",
          "    .patch(id)",
          '    .setIfMissing({ a: "x" })',
          '    .unset(["b", "c.d"])',
          "    .inc({ e: 1 })",
          "    .dec({ f: 1 })",
          '    .append("g", [1])',
          '    .insert("after", "h[-1]", [1])',
          "    .commit();",
        ].join("\n"),
      ),
    });
    const patch = (await extractMutations(dir))[0];
    expect([...(patch?.sets.keys() ?? [])]).toEqual(["a", "b", "c.d", "e", "f", "g", "h[-1]"]);
    expect(patch?.sets.get("b")).toBe("other");
  });

  it("drafts: an id that starts drafts. or comes from a draft helper is handled, a plain id is not", async () => {
    const dir = tree({
      "a.ts": file(
        [
          "  await client.patch(`drafts.${id}`).set({ a: 1 });",
          '  await client.patch("drafts." + id).set({ a: 1 });',
          "  await client.patch(getDraftId(id)).set({ a: 1 });",
          "  await client.patch(id).set({ a: 1 });",
          '  await client.createOrReplace({ _id: `drafts.${id}`, _type: "topic", name: "x" });',
        ].join("\n"),
      ),
    });
    expect((await extractMutations(dir)).map((s) => s.touchesDrafts)).toEqual([
      true,
      true,
      true,
      false,
      true,
    ]);
  });

  it("the route is the address of a route handler, a page route, or the file", async () => {
    const w = "  await client.patch(id).set({ a: 1 });";
    const dir = tree({
      "src/app/(shop)/api/orders/[id]/route.ts": file(w),
      "src/app/api/webhooks/sanity/route.js": plain(w),
      "src/pages/api/hooks/stripe.ts": file(w),
      "src/pages/api/index.ts": file(w),
      "src/lib/helpers.ts": file(w),
    });
    const routes = Object.fromEntries(
      (await extractMutations(dir)).map((s) => [s.source.file, s.route]),
    );
    expect(routes).toEqual({
      "src/app/(shop)/api/orders/[id]/route.ts": "/api/orders/[id]",
      "src/app/api/webhooks/sanity/route.js": "/api/webhooks/sanity",
      "src/pages/api/hooks/stripe.ts": "/api/hooks/stripe",
      "src/pages/api/index.ts": "/api",
      "src/lib/helpers.ts": "src/lib/helpers.ts",
    });
  });

  it("a call on something that is not a Sanity client is not a mutation", async () => {
    const dir = tree({
      "a.ts": file(
        [
          '  await stripe.customers.create({ name: "Ana" });',
          "  const o = Object.create(null);",
          "  await httpClient.patch(`/x/${id}`);",
          "  await prisma.user.delete({ where: { id } });",
          "  await map.delete(id);",
          "  return o;",
        ].join("\n"),
      ),
    });
    expect(await readMutations(dir)).toEqual({ shapes: [], unreadable: [] });
  });

  it("reads .ts, .tsx, .js, .jsx and .mjs, and skips node_modules", async () => {
    const w = file('  await client.patch(id).set({ a: "x" });');
    const j = plain('  await client.patch(id).set({ a: "x" });');
    const dir = tree({
      "a.ts": w,
      "b.tsx": w,
      "c.js": j,
      "d.jsx": j,
      "e.mjs": j,
      "node_modules/x/index.js": j,
    });
    expect((await extractMutations(dir)).map((s) => s.source.file)).toEqual([
      "a.ts",
      "b.tsx",
      "c.js",
      "d.jsx",
      "e.mjs",
    ]);
  });
});

describe("extractMutations: what it cannot read", () => {
  it("a patch whose field name comes from a variable is could not read, with file and line, and is partial", async () => {
    const dir = tree({
      "a.ts": file('  await client.patch(id).set({\n    status: "x",\n    [name]: 1,\n  });'),
    });
    const r = await readMutations(dir);
    expect(r.unreadable).toEqual([{ reason: "variable-key", source: { file: "a.ts", line: 4 } }]);
    expect(r.shapes[0]?.partial).toBe(true);
    expect(sets(r.shapes[0])).toEqual([["status", "string"]]);
  });

  it("a payload that is a variable the file does not define is could not read", async () => {
    const dir = tree({
      "a.ts": file("  await client.patch(id).set(fields);\n  await client.mutate(ops);"),
    });
    const r = await readMutations(dir);
    expect(r.unreadable.map((u) => [u.reason, u.source.line])).toEqual([
      ["variable-payload", 2],
      ["variable-payload", 3],
    ]);
  });

  it("a payload that is a const object in the same file is read, not guessed", async () => {
    const dir = tree({
      "a.ts": file('  const fields = { status: "live" };\n  await client.patch(id).set(fields);'),
    });
    const r = await readMutations(dir);
    expect(r.unreadable).toEqual([]);
    expect(sets(r.shapes[0])).toEqual([["status", "string"]]);
  });

  it("a name declared twice is not resolved", async () => {
    const dir = tree({
      "a.ts": file(
        '  { const fields = { a: "1" }; void fields; }\n  const fields = { b: "2" };\n  await client.patch(id).set(fields);',
      ),
    });
    const r = await readMutations(dir);
    expect(r.unreadable.map((u) => u.reason)).toEqual(["variable-payload"]);
  });

  it("a create that spreads another object keeps the keys that are visible and is marked partial", async () => {
    const dir = tree({
      "a.ts": file('  await client.create({ ...base, _type: "resource", title: "A" });'),
    });
    const r = await readMutations(dir);
    expect(r.shapes[0]?.partial).toBe(true);
    expect(r.shapes[0]?.type).toBe("resource");
    expect(sets(r.shapes[0])).toEqual([["title", "string"]]);
    // A spread is not "could not read": the keys that are written are all there.
    expect(r.unreadable).toEqual([]);
  });

  it("a spread of a const object in the same file contributes its keys", async () => {
    const dir = tree({
      "a.ts": file(
        '  const base = { title: "A" };\n  await client.create({ ...base, _type: "resource" });',
      ),
    });
    const r = await readMutations(dir);
    expect(r.shapes[0]?.partial).toBe(false);
    expect(sets(r.shapes[0])).toEqual([["title", "string"]]);
  });

  it("a file with a syntax error is reported once and none of it is read", async () => {
    const dir = tree({
      "a.ts": "export const x = ;\nawait client.patch(id).set({ a: 1 });\n",
      "b.ts": file('  await client.patch(id).set({ a: "x" });'),
    });
    const r = await readMutations(dir);
    expect(r.unreadable).toEqual([{ reason: "parse-error", source: { file: "a.ts", line: 1 } }]);
    expect(r.shapes.map((s) => s.source.file)).toEqual(["b.ts"]);
  });

  it("a type that is not a literal leaves the create without a type", async () => {
    const dir = tree({ "a.ts": file("  await client.create({ _type: kind, title: 'A' });") });
    expect((await extractMutations(dir))[0]?.type).toBeUndefined();
  });

  it("needs TypeScript: without it the error says how to bring it", async () => {
    const dir = tree({ "a.ts": file("  await client.patch(id).set({ a: 1 });") });
    await expect(
      readMutations(dir, {
        loadTypeScript: () => Promise.reject(new Error("Cannot find package 'typescript'")),
      }),
    ).rejects.toThrow(/TypeScript compiler/);
  });

  it("a folder that does not exist is a ConfigError", async () => {
    await expect(extractMutations(join(tmpdir(), "gaugeline-mut-nowhere"))).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe("readSchema", () => {
  it("reads the types of a `sanity schema extract` file: declared fields, required ones, references", () => {
    const schema = readSchema(
      readFileSync(
        fileURLToPath(new URL("../../../../fixtures/repo-mutations/schema.json", import.meta.url)),
        "utf8",
      ),
    );
    expect([...schema.keys()]).toEqual(["classSession", "instructor", "announcement"]);
    const cls = schema.get("classSession");
    expect(cls?.get("title")).toEqual({ required: true, reference: false });
    expect(cls?.get("status")).toEqual({ required: false, reference: false });
    expect(cls?.get("instructor")).toEqual({ required: true, reference: true });
    // System fields are not declared fields.
    expect(cls?.has("_id")).toBe(false);
  });

  it("skips type declarations, and a reference inside a union is still a reference", () => {
    const schema = readSchema(
      JSON.stringify([
        { type: "type", name: "seo", value: { type: "object", attributes: {} } },
        {
          type: "document",
          name: "page",
          attributes: {
            author: {
              type: "objectAttribute",
              value: {
                type: "union",
                of: [
                  { type: "null" },
                  {
                    type: "object",
                    attributes: {
                      _type: {
                        type: "objectAttribute",
                        value: { type: "string", value: "reference" },
                      },
                    },
                    dereferencesTo: "person",
                  },
                ],
              },
              optional: true,
            },
          },
        },
      ]),
    );
    expect([...schema.keys()]).toEqual(["page"]);
    expect(schema.get("page")?.get("author")).toEqual({ required: false, reference: true });
  });

  it("text that is not a schema file is a ConfigError that names --schema", () => {
    for (const text of ["not json", "{}", "[1]", '[{"type":"document"}]'])
      expect(() => readSchema(text), text).toThrow(/--schema/);
  });

  it("a missing file is a ConfigError that names --schema", async () => {
    const dir = tree({});
    await expect(readSchemaFile(join(dir, "schema.json"))).rejects.toThrow(/--schema/);
    await expect(readSchemaFile(join(dir, "schema.json"))).rejects.toBeInstanceOf(ConfigError);
  });
});

/** One shape by hand, for the rules that do not need a source file. */
function shape(over: Partial<MutationShape> & Pick<MutationShape, "kind">): MutationShape {
  return {
    sets: new Map(),
    touchesDrafts: true,
    partial: false,
    route: "/api/x",
    source: { file: "src/x.ts", line: 3 },
    ...over,
  };
}

describe("checkMutations: the five findings", () => {
  it("mutation-undeclared-field: a patch sets a field no type declares, with file and line", () => {
    const f = checkMutations(
      [
        shape({
          kind: "patch",
          sets: new Map([
            ["status", "string"],
            ["colour", "string"],
          ]),
        }),
      ],
      SCHEMA,
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      checkId: "mutation-undeclared-field",
      severity: "high",
      title: MUTATION_TITLES.undeclared,
      source: { file: "src/x.ts", line: 3 },
    });
    expect(f[0]?.evidence).toContain("src/x.ts:3");
    expect(f[0]?.evidence).toContain("colour");
    expect(f[0]?.evidence).not.toContain("status");
  });

  it("mutation-undeclared-field: a create is checked against its own type, system fields are fine", () => {
    const f = checkMutations(
      [
        shape({
          kind: "create",
          type: "topic",
          sets: new Map([
            ["_id", "other"],
            ["name", "string"],
            ["status", "string"],
          ]),
        }),
      ],
      SCHEMA,
    );
    // status is declared by resource, not by topic.
    expect(f.map((x) => x.checkId)).toEqual(["mutation-undeclared-field"]);
    expect(f[0]?.evidence).toContain("topic");
  });

  it("mutation-undeclared-field: a dotted or indexed path is checked on its first segment", () => {
    const f = checkMutations(
      [
        shape({
          kind: "patch",
          sets: new Map([
            ["status.x", "other"],
            ["summary[0]", "other"],
            ["nope.x", "other"],
          ]),
        }),
      ],
      SCHEMA,
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toContain("nope.x");
  });

  it("mutation-missing-required: a create without a field the schema marks required", () => {
    const f = checkMutations(
      [shape({ kind: "create", type: "resource", sets: new Map([["title", "string"]]) })],
      SCHEMA,
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      checkId: "mutation-missing-required",
      severity: "high",
      title: MUTATION_TITLES.missing,
    });
    expect(f[0]?.evidence).toContain("owner");
    expect(f[0]?.evidence).toContain("resource");
  });

  it("mutation-missing-required: createOrReplace and createIfNotExists too; a patch, a delete and an unknown type are not", () => {
    const empty = new Map<string, "string" | "ref" | "other">();
    const f = checkMutations(
      [
        shape({ kind: "createOrReplace", type: "topic", sets: empty }),
        shape({ kind: "createIfNotExists", type: "topic", sets: empty }),
        shape({ kind: "patch", sets: empty }),
        shape({ kind: "delete" }),
        shape({ kind: "create", type: "mystery", sets: empty }),
        shape({ kind: "create", sets: empty }),
      ],
      SCHEMA,
    );
    expect(f.map((x) => x.checkId)).toEqual([
      "mutation-missing-required",
      "mutation-missing-required",
    ]);
  });

  it("mutation-ref-as-string: a reference field given a plain string", () => {
    const f = checkMutations(
      [
        shape({
          kind: "create",
          type: "resource",
          sets: new Map([
            ["title", "string"],
            ["owner", "string"],
          ]),
        }),
      ],
      SCHEMA,
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      checkId: "mutation-ref-as-string",
      severity: "high",
      title: MUTATION_TITLES.refAsString,
    });
    expect(f[0]?.evidence).toContain("_ref");
  });

  it("mutation-ref-as-string: an object with _ref is fine, and so is a patch of a field several types declare differently", () => {
    const schema: SchemaShape = new Map([
      ["a", new Map([["link", field(false, true)]])],
      ["b", new Map([["link", field(false, false)]])],
    ]);
    expect(
      checkMutations(
        [
          shape({ kind: "create", type: "a", sets: new Map([["link", "ref"]]) }),
          shape({ kind: "patch", sets: new Map([["link", "string"]]) }),
        ],
        schema,
      ),
    ).toEqual([]);
    // Every type that declares the field says reference: a patch is wrong whichever it is.
    const f = checkMutations(
      [shape({ kind: "patch", sets: new Map([["owner", "string"]]) })],
      SCHEMA,
    );
    expect(f.map((x) => x.checkId)).toEqual(["mutation-ref-as-string"]);
  });

  it("mutation-no-drafts: a patch, createOrReplace or delete that does not touch drafts", () => {
    const f = checkMutations(
      [
        shape({ kind: "patch", touchesDrafts: false }),
        shape({
          kind: "createOrReplace",
          type: "topic",
          touchesDrafts: false,
          sets: new Map([["name", "string"]]),
        }),
        shape({ kind: "delete", touchesDrafts: false }),
        shape({ kind: "patch", touchesDrafts: true }),
      ],
      SCHEMA,
    );
    expect(f.map((x) => [x.checkId, x.severity])).toEqual([
      ["mutation-no-drafts", "medium"],
      ["mutation-no-drafts", "medium"],
      ["mutation-no-drafts", "medium"],
    ]);
    expect(f[0]?.title).toBe(MUTATION_TITLES.noDrafts);
  });

  it("mutation-no-drafts: a create makes a new document, so it is not editing published content", () => {
    expect(
      checkMutations(
        [
          shape({
            kind: "create",
            type: "topic",
            touchesDrafts: false,
            sets: new Map([["name", "string"]]),
          }),
        ],
        SCHEMA,
      ),
    ).toEqual([]);
  });

  it("the operations inside a transaction are checked one by one, and a finding names the operation's own line", () => {
    const tx = shape({
      kind: "transaction",
      source: { file: "src/t.ts", line: 10 },
      ops: [
        shape({
          kind: "create",
          type: "resource",
          sets: new Map([["title", "string"]]),
          source: { file: "src/t.ts", line: 11 },
        }),
        shape({
          kind: "patch",
          touchesDrafts: false,
          sets: new Map([["status", "string"]]),
          source: { file: "src/t.ts", line: 12 },
        }),
      ],
    });
    const f = checkMutations([tx], SCHEMA);
    expect(f.map((x) => [x.checkId, x.source?.line])).toEqual([
      ["mutation-missing-required", 11],
      ["mutation-no-drafts", 12],
    ]);
  });

  it("a partial create is not reported as missing a field the spread may carry, but its visible keys are checked", () => {
    const f = checkMutations(
      [
        shape({
          kind: "create",
          type: "resource",
          partial: true,
          sets: new Map([
            ["title", "string"],
            ["owner", "string"],
            ["colour", "string"],
          ]),
        }),
      ],
      SCHEMA,
    );
    expect(f.map((x) => x.checkId)).toEqual([
      "mutation-ref-as-string",
      "mutation-undeclared-field",
    ]);
  });

  it("mutation-shared-field: two route files setting resource.status give one finding naming both", () => {
    const f = checkMutations(
      [
        shape({
          kind: "patch",
          sets: new Map([["status", "string"]]),
          route: "/api/a",
          source: { file: "src/a/route.ts", line: 4 },
        }),
        shape({
          kind: "patch",
          sets: new Map([["status", "string"]]),
          route: "/api/b",
          source: { file: "src/b/route.ts", line: 9 },
        }),
      ],
      SCHEMA,
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      checkId: "mutation-shared-field",
      severity: "medium",
      title: MUTATION_TITLES.shared,
    });
    expect(f[0]?.evidence).toContain("resource.status");
    expect(f[0]?.evidence).toContain("src/a/route.ts:4");
    expect(f[0]?.evidence).toContain("src/b/route.ts:9");
  });

  it("mutation-shared-field: one route writing a field twice is one route; three routes are named in order", () => {
    const at = (route: string, line: number) => ({ route, source: { file: `${route}.ts`, line } });
    const w = (route: string, line: number) =>
      shape({ kind: "patch", sets: new Map([["status", "string"]]), ...at(route, line) });
    expect(checkMutations([w("/a", 1), w("/a", 5)], SCHEMA)).toEqual([]);
    const f = checkMutations([w("/a", 1), w("/b", 2), w("/c", 3), w("/a", 5)], SCHEMA);
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toMatch(/\/a\.ts:1.*\/b\.ts:2.*\/c\.ts:3/);
  });

  it("mutation-shared-field: setIfMissing and unset count as writes to that field", () => {
    const f = checkMutations(
      [
        shape({
          kind: "patch",
          sets: new Map([["status", "string"]]),
          route: "/a",
          source: { file: "a.ts", line: 1 },
        }),
        shape({
          kind: "patch",
          sets: new Map([["status", "other"]]),
          route: "/b",
          source: { file: "b.ts", line: 1 },
        }),
      ],
      SCHEMA,
    );
    expect(f.map((x) => x.checkId)).toEqual(["mutation-shared-field"]);
  });

  it("mutation-shared-field: a createOrReplace counts with the type it names; a patch of a field several types declare is not attributed", () => {
    const schema: SchemaShape = new Map([
      ["a", new Map([["note", field()]])],
      ["b", new Map([["note", field()]])],
    ]);
    const note = (kind: "patch" | "createOrReplace", route: string, type?: string) =>
      shape({
        kind,
        ...(type ? { type } : {}),
        sets: new Map([["note", "string"]]),
        route,
        source: { file: `${route}.ts`, line: 1 },
      });
    expect(checkMutations([note("patch", "/x"), note("patch", "/y")], schema)).toEqual([]);
    const f = checkMutations(
      [
        note("createOrReplace", "/x", "a"),
        note("createOrReplace", "/y", "a"),
        note("createOrReplace", "/z", "b"),
      ],
      schema,
    );
    expect(f.map((x) => x.checkId)).toEqual(["mutation-shared-field"]);
    expect(f[0]?.evidence).toContain("a.note");
  });

  it("system fields are never a shared field", () => {
    const f = checkMutations(
      [
        shape({
          kind: "create",
          type: "topic",
          sets: new Map([
            ["_id", "string"],
            ["name", "string"],
          ]),
          route: "/a",
        }),
        shape({
          kind: "create",
          type: "topic",
          sets: new Map([
            ["_id", "string"],
            ["name", "string"],
          ]),
          route: "/b",
        }),
      ],
      SCHEMA,
    );
    expect(f.map((x) => x.evidence.includes("_id"))).not.toContain(true);
  });

  it("text from the code is escaped in the evidence", () => {
    const f = checkMutations(
      [shape({ kind: "patch", sets: new Map([["a\u200Bb\u202Ec", "string"]]) })],
      SCHEMA,
    );
    expect(f[0]?.evidence).not.toMatch(/[\u200B\u202E]/);
    expect(f[0]?.evidence).toContain("\\u{200B}");
  });

  it("the same input gives the same findings", () => {
    const input = [
      shape({ kind: "patch", sets: new Map([["nope", "string"]]) }),
      shape({ kind: "create", type: "resource", sets: new Map() }),
    ];
    expect(checkMutations(input, SCHEMA)).toEqual(checkMutations(input, SCHEMA));
  });
});

const repo = fileURLToPath(new URL("../../../../fixtures/repo-mutations/", import.meta.url));

describe("fixtures/repo-mutations: integration", () => {
  it("its findings match the snapshot, each with file and line", async () => {
    const schema = readSchema(readFileSync(join(repo, "schema.json"), "utf8"));
    const read = await readMutations(repo);
    const findings = checkMutations(read.shapes, schema).map((f) => ({
      checkId: f.checkId,
      severity: f.severity,
      source: f.source,
      evidence: f.evidence,
    }));
    const expectedFile = fileURLToPath(new URL("./repo-mutations.expected.json", import.meta.url));
    if (process.env.UPDATE_EXPECTED === "1")
      writeFileSync(
        expectedFile,
        `${JSON.stringify({ unreadable: read.unreadable, findings }, null, 2)}\n`,
      );
    expect({ unreadable: read.unreadable, findings }).toEqual(
      JSON.parse(readFileSync(expectedFile, "utf8")),
    );
  });

  it("has 4 routes and 1 webhook handler that write, and one of each of the five findings", async () => {
    const schema = readSchema(readFileSync(join(repo, "schema.json"), "utf8"));
    const read = await readMutations(repo);
    expect(new Set(read.shapes.map((s) => s.route)).size).toBe(5);
    expect(read.shapes.map((s) => s.route)).toContain("/api/webhooks/sanity");
    expect(
      checkMutations(read.shapes, schema)
        .map((f) => f.checkId)
        .sort(),
    ).toEqual([
      "mutation-missing-required",
      "mutation-no-drafts",
      "mutation-ref-as-string",
      "mutation-shared-field",
      "mutation-undeclared-field",
    ]);
  });
});

/**
 * What mutations.ts may not reach, directly or through anything it imports: the fetcher and its
 * transport, the Sanity reader and the connectors, the modules of query/ that ask a dataset, and
 * every module that opens a connection.
 */
const BANNED_IMPORT =
  /(^|\/)(fetcher|transport|sanity|http|connectors\/[^"']*|(?:\.\/)?(?:run|counts|dupes))(\.js|\.ts)?$|^node:(http|https|http2|net|tls|dns|dgram|child_process|worker_threads)$|^(undici|axios|got|node-fetch|ky|@sanity\/[^"']*)$/;

describe("mutations are parsed and never sent", () => {
  /** Anything that opens a connection fails the test. */
  function throwingNetwork() {
    const boom = (name: string) => () => {
      throw new Error(`${name} was called: a mutation check must not touch the network`);
    };
    const calls = [
      vi.spyOn(http, "request").mockImplementation(boom("http.request")),
      vi.spyOn(http, "get").mockImplementation(boom("http.get")),
      vi.spyOn(https, "request").mockImplementation(boom("https.request")),
      vi.spyOn(https, "get").mockImplementation(boom("https.get")),
      vi.spyOn(net, "connect").mockImplementation(boom("net.connect")),
      vi.spyOn(net, "createConnection").mockImplementation(boom("net.createConnection")),
    ];
    vi.stubGlobal("fetch", vi.fn(boom("fetch")));
    return calls;
  }

  it("reading, checking and listing the fixture makes zero calls, and the code that sends is never run", async () => {
    const spies = throwingNetwork();
    const fetchStub = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const schema = readSchema(readFileSync(join(repo, "schema.json"), "utf8"));
    const read = await readMutations(repo);
    const findings = checkMutations(read.shapes, schema);
    expect(findings.length).toBeGreaterThan(0);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a source file that would send a mutation is read, and its code is not evaluated", async () => {
    const dir = tree({
      "a.ts": [
        'import { createClient } from "@sanity/client";',
        'throw new Error("this file was executed");',
        "export const client = createClient({});",
        "await client.patch('x').set({ a: 1 }).commit();",
        "",
      ].join("\n"),
    });
    const spies = throwingNetwork();
    const shapes = await extractMutations(dir);
    expect(shapes).toHaveLength(1);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("mutations.ts and what it imports reach no fetcher, no Sanity reader and no HTTP client", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const seen = new Set<string>();
    const visit = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(
        /(?:^|\n)\s*(?:import|export)\b[^"';]*?\bfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g,
      )) {
        const spec = m[1] ?? m[2] ?? m[3] ?? "";
        // "import type" is erased by the compiler and cannot send anything.
        if (/\bimport\s+type\b|\bexport\s+type\b/.test(m[0]) && !m[3]) continue;
        // `typescript` is loaded by name on purpose (the compiler, optional); it holds no HTTP client.
        if (spec === "typescript") continue;
        expect(spec, `${path} imports ${spec}`).not.toMatch(BANNED_IMPORT);
        if (spec.startsWith(".")) visit(resolve(dirname(path), spec.replace(/\.js$/, ".ts")));
      }
    };
    visit(resolve(here, "../mutations.ts"));
    // It does walk further than the one file.
    expect(seen.size).toBeGreaterThan(2);
    // And no file of it names the global fetch.
    for (const f of seen) expect(readFileSync(f, "utf8")).not.toMatch(/(^|[^.\w])fetch\s*\(/);
  });

  it("the import rule can fail: it matches the fetcher, the Sanity reader and the HTTP modules", () => {
    for (const spec of [
      "../fetcher.js",
      "../transport.js",
      "../connectors/sanity.js",
      "./run.js",
      "node:https",
      "undici",
      "@sanity/client",
    ])
      expect(spec).toMatch(BANNED_IMPORT);
    for (const spec of ["./source.js", "node:path", "../errors.js", "../model.js"])
      expect(spec).not.toMatch(BANNED_IMPORT);
  });
});
