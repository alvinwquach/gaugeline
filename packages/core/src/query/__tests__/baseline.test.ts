import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Finding } from "../../model.js";
import {
  BASELINE_SCHEMA,
  diffBaseline,
  gapKey,
  gapOf,
  likelyRenames,
  parseBaseline,
  serializeBaseline,
  toBaseline,
  type BaselineGap,
} from "../baseline.js";
import { compareWithCounts, type TypeCounts } from "../counts.js";
import type { QueryShape } from "../shape.js";

const NOW = new Date("2026-11-10T12:00:00Z");

const shape = (over: Partial<QueryShape> & { file?: string; line?: number } = {}): QueryShape => ({
  type: over.type ?? "popup",
  fields: (over.fields ?? [{ path: "date" }]).map((f) => ({
    path: f.path,
    deref: false,
    source: { file: over.file ?? "src/events.ts", line: over.line ?? 3 },
  })),
  excludesDrafts: over.excludesDrafts ?? true,
  params: [],
  source: { file: over.file ?? "src/events.ts", line: over.line ?? 3 },
});

const counts = (total: number, defined: Record<string, number>): Map<string, TypeCounts> =>
  new Map([["popup", { type: "popup", total, defined: new Map(Object.entries(defined)) }]]);

const gap = (checkId: string, type: string, field: string | undefined, file: string) => {
  const g: Omit<BaselineGap, "key"> = {
    checkId,
    type,
    ...(field === undefined ? {} : { field }),
    file,
  };
  return { key: gapKey(g), ...g } as BaselineGap;
};

/** A finding as the query checks write it: the file and line are in the text and in `source`. */
const f = (
  checkId: string,
  file: string,
  line: number,
  rest: string,
  over: Partial<Finding> = {},
): Finding => ({
  checkId,
  severity: "high",
  title: "A title",
  evidence: `${file}:${line}  ${rest}`,
  url: "sanity:popup",
  source: { file, line },
  ...over,
});

afterEach(() => vi.useRealTimers());

describe("the key of a gap", () => {
  it("is the same for the same finding at another line and with other counts", () => {
    const a = compareWithCounts([shape({ line: 3 })], counts(9, { date: 0 }));
    const b = compareWithCounts([shape({ line: 41 })], counts(300, { date: 0 }));
    expect(a[0]?.evidence).not.toBe(b[0]?.evidence);
    expect(toBaseline(a, NOW).gaps).toEqual(toBaseline(b, NOW).gaps);
    const partialA = compareWithCounts([shape()], counts(40, { date: 12 }));
    const partialB = compareWithCounts([shape({ line: 90 })], counts(41, { date: 12 }));
    expect(partialA[0]?.checkId).toBe("query-field-partial");
    expect(toBaseline(partialA, NOW).gaps).toEqual(toBaseline(partialB, NOW).gaps);
  });

  it("joins the check, the type, the field and the file, and changes with each of them", () => {
    const base = gap("query-field-absent", "popup", "date", "src/events.ts");
    expect(base.key).toContain("query-field-absent");
    expect(base.key).toContain("popup");
    expect(base.key).toContain("date");
    expect(base.key).toContain("src/events.ts");
    const others = [
      gap("query-field-partial", "popup", "date", "src/events.ts"),
      gap("query-field-absent", "post", "date", "src/events.ts"),
      gap("query-field-absent", "popup", "startsAt", "src/events.ts"),
      gap("query-field-absent", "popup", "date", "src/other.ts"),
      gap("query-field-absent", "popup", undefined, "src/events.ts"),
    ];
    expect(new Set([base, ...others].map((g) => g.key)).size).toBe(6);
  });

  it("cannot be forged by a name that holds the separator", () => {
    const a = gapKey({ checkId: "c", type: "a|b", field: "c", file: "d" });
    const b = gapKey({ checkId: "c", type: "a", field: "b|c", file: "d" });
    expect(a).not.toBe(b);
  });

  it("reads the type from the finding's address and the field from its text, escaped as shown", () => {
    const absent = f(
      "query-field-absent",
      "src/a.ts",
      3,
      "date doesn't exist on any popup: 0 of 9 documents have it. The field was probably renamed.",
    );
    expect(gapOf(absent)).toMatchObject({ type: "popup", field: "date", file: "src/a.ts" });
    const partial = f(
      "query-field-partial",
      "src/a.ts",
      9,
      "sections[].heading is missing on 2 of 6 documents. Fine if it is optional.",
    );
    expect(gapOf(partial)?.field).toBe("sections[].heading");
    const drafts = f(
      "query-no-drafts-filter",
      "src/a.ts",
      9,
      "The popup query's filter does not leave drafts out.",
      { severity: "medium" },
    );
    expect(gapOf(drafts)).toEqual({
      key: gapKey({ checkId: "query-no-drafts-filter", type: "popup", file: "src/a.ts" }),
      checkId: "query-no-drafts-filter",
      type: "popup",
      file: "src/a.ts",
    });
  });

  it("reads the field of the three mutation checks that name one", () => {
    const write = (checkId: string, rest: string) =>
      gapOf(f(checkId, "src/api.ts", 7, rest, { url: "sanity:order" }));
    expect(
      write(
        "mutation-undeclared-field",
        "This patch writes status, and the order type does not declare it. Sanity stores it.",
      )?.field,
    ).toBe("status");
    expect(
      write("mutation-ref-as-string", "customer is a reference, and this patch gives it a string.")
        ?.field,
    ).toBe("customer");
    expect(
      write(
        "mutation-missing-required",
        "This create of order leaves out total, which the schema marks required.",
      )?.field,
    ).toBe("total");
    expect(
      write("mutation-no-drafts", "This patch has no drafts handling.")?.field,
    ).toBeUndefined();
    const shared = gapOf({
      checkId: "mutation-shared-field",
      severity: "medium",
      title: "t",
      evidence: "order.status is written by 2 routes: src/a.ts:3, src/b.ts:9.",
      url: "sanity:order",
      source: { file: "src/a.ts", line: 3 },
    });
    expect(shared).toMatchObject({ type: "order", field: "order.status", file: "src/a.ts" });
  });

  it("gives a finding with no file the empty file, so it can still be told apart by check and type", () => {
    const g = gapOf({
      checkId: "query-dupe-slug",
      severity: "medium",
      title: "t",
      evidence: "ids",
      url: "sanity:menuItem",
    });
    expect(g).toMatchObject({ checkId: "query-dupe-slug", type: "menuItem", file: "" });
  });
});

describe("toBaseline", () => {
  const findings = [
    f("query-field-partial", "src/z.ts", 4, "allergens is missing on 3 of 9 documents."),
    f("query-field-absent", "src/a.ts", 3, "date doesn't exist on any popup: 0 of 9."),
    f("query-field-absent", "src/a.ts", 20, "date doesn't exist on any popup: 0 of 9."),
    f("query-field-absent", "src/b.ts", 8, "date doesn't exist on any popup: 0 of 9."),
  ];

  it("writes the schema number and the injected time, and one gap for each key", () => {
    const b = toBaseline(findings, NOW);
    expect(b.schema).toBe(BASELINE_SCHEMA);
    expect(b.schema).toBe(1);
    expect(b.createdAt).toBe("2026-11-10T12:00:00.000Z");
    // The same field twice in one file is one gap, the cost the architecture notes name.
    expect(b.gaps).toHaveLength(3);
  });

  it("is sorted by key, whatever order the findings came in, so the file diffs cleanly in git", () => {
    const keys = toBaseline(findings, NOW).gaps.map((g) => g.key);
    expect(keys).toEqual([...keys].sort());
    expect(toBaseline([...findings].reverse(), NOW)).toEqual(toBaseline(findings, NOW));
  });

  it("sorts by code unit, not by the language of the machine", () => {
    const b = toBaseline(
      [
        f("c", "src/é.ts", 1, "x", { url: "sanity:t" }),
        f("c", "src/Z.ts", 1, "x", { url: "sanity:t" }),
        f("c", "src/a.ts", 1, "x", { url: "sanity:t" }),
      ],
      NOW,
    );
    expect(b.gaps.map((g) => g.file)).toEqual(["src/Z.ts", "src/a.ts", "src/é.ts"]);
  });

  it("never reads the system clock: it uses the date it is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    expect(toBaseline(findings, NOW).createdAt).toBe("2026-11-10T12:00:00.000Z");
    const source = readFileSync(fileURLToPath(new URL("../baseline.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/Date\.now\(|new Date\(\s*\)|performance\.now/);
  });

  it("is plain JSON with sorted keys inside each gap and a final newline", () => {
    const text = serializeBaseline(toBaseline(findings, NOW));
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as { gaps: Array<Record<string, string>> };
    expect(Object.keys(parsed)).toEqual(["schema", "createdAt", "gaps"]);
    for (const g of parsed.gaps)
      expect(Object.keys(g)).toEqual(Object.keys(g).sort((a, b) => (a < b ? -1 : 1)));
    expect(parseBaseline(text, "before.json")).toEqual(toBaseline(findings, NOW));
  });
});

describe("diffBaseline", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const finding = (id: string): Finding =>
    f("query-field-absent", `src/${id}.ts`, 3, `date doesn't exist on any popup: 0 of 9.`);

  it("3 before and 5 after, sharing 2, gives created 3, closed 1 and carried 2", () => {
    const before = toBaseline(["a", "b", "x"].map(finding), NOW);
    const after = ids.map(finding);
    const d = diffBaseline(before, after);
    expect(d.created.map((x) => x.source?.file)).toEqual(["src/c.ts", "src/d.ts", "src/e.ts"]);
    expect(d.closed.map((g) => g.file)).toEqual(["src/x.ts"]);
    expect(d.carried).toBe(2);
  });

  it("lists every created finding, even two with the same key, so every line to edit is shown", () => {
    const before = toBaseline([finding("a")], NOW);
    const second = f(
      "query-field-absent",
      "src/b.ts",
      40,
      "date doesn't exist on any popup: 0 of 9.",
    );
    const d = diffBaseline(before, [finding("a"), finding("b"), second]);
    expect(d.created.map((x) => `${x.source?.file}:${x.source?.line}`)).toEqual([
      "src/b.ts:3",
      "src/b.ts:40",
    ]);
    expect(d.carried).toBe(1);
  });

  it("an empty baseline makes everything created", () => {
    const d = diffBaseline(toBaseline([], NOW), ids.map(finding));
    expect(d.created).toHaveLength(5);
    expect(d.closed).toEqual([]);
    expect(d.carried).toBe(0);
  });

  it("nothing after closes everything", () => {
    const d = diffBaseline(toBaseline(ids.map(finding), NOW), []);
    expect(d.created).toEqual([]);
    expect(d.closed).toHaveLength(5);
    expect(d.carried).toBe(0);
  });

  it("a finding that moved inside its file, or whose counts changed, is carried", () => {
    const before = toBaseline(
      compareWithCounts([shape({ line: 3 })], counts(40, { date: 12 })),
      NOW,
    );
    const after = compareWithCounts([shape({ line: 55 })], counts(41, { date: 12 }));
    expect(diffBaseline(before, after)).toEqual({ created: [], closed: [], carried: 1 });
  });

  it("a gap that got worse (missing on some becomes missing on all) is a different check, so it is created", () => {
    const before = toBaseline(compareWithCounts([shape()], counts(40, { date: 12 })), NOW);
    const after = compareWithCounts([shape()], counts(40, { date: 0 }));
    const d = diffBaseline(before, after);
    expect(d.created.map((x) => x.checkId)).toEqual(["query-field-absent"]);
    expect(d.closed.map((g) => g.checkId)).toEqual(["query-field-partial"]);
  });

  it("returns the findings themselves, with their text and line", () => {
    const d = diffBaseline(toBaseline([], NOW), [finding("a")]);
    expect(d.created[0]?.evidence).toContain("src/a.ts:3");
  });
});

describe("likelyRenames", () => {
  it("pairs a file whose gaps all closed with a file whose gaps are the same ones, created", () => {
    const closed = [
      gap("query-field-absent", "popup", "date", "src/events/page.tsx"),
      gap("query-no-drafts-filter", "popup", undefined, "src/events/page.tsx"),
    ];
    const created = [
      f(
        "query-field-absent",
        "src/events/index.tsx",
        3,
        "date doesn't exist on any popup: 0 of 9.",
      ),
      f(
        "query-no-drafts-filter",
        "src/events/index.tsx",
        3,
        "The popup query's filter does not leave drafts out.",
      ),
    ];
    expect(likelyRenames(closed, created)).toEqual([
      { from: "src/events/page.tsx", to: "src/events/index.tsx" },
    ]);
  });

  it("says nothing when the gaps differ, or when two files would claim the same one", () => {
    const closed = [gap("query-field-absent", "popup", "date", "src/a.ts")];
    expect(
      likelyRenames(closed, [
        f("query-field-absent", "src/b.ts", 1, "startsAt doesn't exist on any popup: 0 of 9."),
      ]),
    ).toEqual([]);
    const twice = [
      f("query-field-absent", "src/b.ts", 1, "date doesn't exist on any popup: 0 of 9."),
      f("query-field-absent", "src/c.ts", 1, "date doesn't exist on any popup: 0 of 9."),
    ];
    expect(likelyRenames(closed, twice)).toEqual([]);
  });
});

describe("parseBaseline", () => {
  const good = serializeBaseline(
    toBaseline(
      [f("query-field-absent", "src/a.ts", 3, "date doesn't exist on any popup: 0.")],
      NOW,
    ),
  );

  it("reads what serializeBaseline wrote", () => {
    expect(parseBaseline(good, "before.json").gaps).toHaveLength(1);
  });

  it("refuses a baseline of another schema number, naming the file and both numbers", () => {
    const newer = good.replace('"schema": 1', '"schema": 2');
    expect(() => parseBaseline(newer, "before.json")).toThrowError(
      /before\.json.*schema 2.*reads schema 1/s,
    );
    try {
      parseBaseline(newer, "before.json");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("config");
      expect((e as { hint?: string }).hint).toMatch(/--save/);
    }
  });

  it("refuses text that is not a baseline, without echoing any of it", () => {
    for (const bad of [
      "not json at all SECRET-MARKER",
      "[]",
      "{}",
      '{"schema":1}',
      '{"schema":1,"createdAt":"x","gaps":[{"key":"k"}]}',
      '{"schema":"1","createdAt":"2026-11-10T12:00:00.000Z","gaps":[]}',
    ]) {
      let message = "";
      try {
        parseBaseline(bad, "before.json");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, bad).toMatch(/before\.json is not a Gaugeline baseline/);
      expect(message).not.toContain("SECRET-MARKER");
    }
  });

  it("refuses a gap whose key does not match its parts: the file was edited", () => {
    const edited = good.replace('"file": "src/a.ts"', '"file": "src/elsewhere.ts"');
    expect(() => parseBaseline(edited, "before.json")).toThrowError(/was edited/);
  });
});
