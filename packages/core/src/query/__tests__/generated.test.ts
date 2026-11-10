import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  FENNEL_MEALS,
  MEALS_MARKER,
  mealsContent,
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { createGeneratedRegistry, QUERY_GENERATED_CHECKS } from "../../checks/query-generated.js";
import { QueryTooLongError, createSanityRead, type SanityRead } from "../../connectors/sanity.js";
import { ConfigError } from "../../errors.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { resultSchema } from "../../result.js";
import {
  GENERATED_TITLES,
  RuleError,
  checkRefs,
  checkTotals,
  groupByDocument,
  parseRefsRule,
  parseTotalsRule,
  refsQuery,
  totalsQuery,
} from "../generated.js";
import { compareGenerated } from "../run.js";

const NOW = new Date("2026-11-10T12:00:00Z");
const ENV = { SANITY_PROJECT_ID: "fennel1", SANITY_DATASET: "production" };

/** The transport, with every answer it gave kept as text so a test can read what came back. */
function recording(inner: Transport, bodies: string[]): Transport {
  return async (url, req) => {
    const res = await inner(url, req);
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(Buffer.from(c as Uint8Array));
    const text = Buffer.concat(chunks).toString("utf8");
    bodies.push(text);
    return { ...res, body: Readable.from([Buffer.from(text)]) };
  };
}

function dataset(spec: FakeSanity = FENNEL_MEALS) {
  const seen: SeenSanityRequest[] = [];
  const bodies: string[] = [];
  const fetcher = createFetcher({
    transport: recording(sanityCountsTransport(spec, seen), bodies),
    timeoutMs: 5000,
  });
  const read: SanityRead = createSanityRead(ENV, fetcher);
  return { seen, bodies, read, fetcher };
}

const withDocs = (documents: Record<string, Record<string, unknown>[]>): FakeSanity => ({
  types: {},
  content: documents,
});

describe("parseTotalsRule and parseRefsRule: unit", () => {
  it("reads the two examples from the page", () => {
    expect(parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories")).toEqual({
      type: "mealPlan",
      stated: "targetCalories",
      parts: "days[].meals[]->calories",
    });
    expect(parseRefsRule("mealPlan:meals")).toEqual({
      type: "mealPlan",
      path: "meals",
    });
  });

  it("reads dotted stated fields, nested parts and a refs path that ends in []", () => {
    expect(parseTotalsRule("invoice:totals.gross=lines[].price")).toMatchObject({
      stated: "totals.gross",
      parts: "lines[].price",
    });
    expect(parseTotalsRule("order:total=items[]->price.amount").parts).toBe(
      "items[]->price.amount",
    );
    expect(parseRefsRule("mealPlan:days[].meals[]").path).toBe("days[].meals[]");
  });

  it("a missing equals sign is a RuleError that says where", () => {
    const rule = "mealPlan:targetCalories days[].meals[]->calories";
    let caught: unknown;
    try {
      parseTotalsRule(rule);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RuleError);
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as RuleError).position).toBe(rule.length + 1);
    expect((caught as RuleError).message).toContain('an "=" is missing');
    expect((caught as RuleError).message).toContain(`(character ${rule.length + 1})`);
  });

  it("a missing colon, an empty type and an empty side are refused", () => {
    expect(() => parseTotalsRule("mealPlan")).toThrow(/":" is missing/);
    expect(() => parseTotalsRule(":a=b")).toThrow(/type is missing/);
    expect(() => parseTotalsRule("mealPlan:=days")).toThrow(/the stated field is empty/);
    expect(() => parseTotalsRule("mealPlan:a=")).toThrow(/the parts path is empty/);
    expect(() => parseRefsRule("mealPlan:")).toThrow(/the path is empty/);
  });

  it("a field name with a quote in it is rejected at the quote", () => {
    for (const [rule, position] of [
      ['mealPlan:target"Calories=days[].calories', 16],
      ["mealPlan:total=days[].cal'ories", 26],
      ['mealPlan:total=days[]["calories"]', 22],
    ] as const) {
      let caught: unknown;
      try {
        parseTotalsRule(rule);
      } catch (err) {
        caught = err;
      }
      expect(caught, rule).toBeInstanceOf(RuleError);
      expect((caught as RuleError).position, rule).toBe(position);
    }
    expect(() => parseRefsRule('mealPlan:me"als')).toThrow(RuleError);
    expect(() => parseRefsRule('meal"Plan:meals')).toThrow(/document type name/);
  });

  it("refuses what could change a query: spaces, brackets with content, GROQ operators, keywords", () => {
    for (const bad of [
      "mealPlan:a=b c",
      "mealPlan:a=b[0].c",
      "mealPlan:a=b[x == 1].c",
      "mealPlan:a=b + c",
      "mealPlan:a=b]",
      "mealPlan:a=b.",
      "mealPlan:a=b->",
      "mealPlan:a=b[]",
      "mealPlan:a=b[]c",
      "mealPlan:a=in.b",
      "mealPlan:a.b[]=c",
      "mealPlan:a->b=c",
      "mealPlan:a=b=c",
      "mealPlan:a=b:c",
      "meal Plan:a=b",
      "mealPlan:a=b\nc",
      `mealPlan:a=${"x".repeat(300)}`,
    ])
      expect(() => parseTotalsRule(bad), bad).toThrow(RuleError);
    for (const bad of [
      "mealPlan:a->b",
      "mealPlan:a b",
      "mealPlan:a.",
      "mealPlan:[]",
      "mealPlan:a[0]",
    ])
      expect(() => parseRefsRule(bad), bad).toThrow(RuleError);
  });

  it("shows an invisible character in a rule escaped, never raw", () => {
    let message = "";
    try {
      parseRefsRule("mealPlan:me​als");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("\\u{200B}");
    expect(message).not.toContain("​");
  });
});

describe("the built queries", () => {
  it("totals: one object with the count, two lists of ids and two counts", () => {
    expect(totalsQuery(parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories")))
      .toMatchInlineSnapshot(`
      "{"documents":count(*[_type == "mealPlan"]),"unstated":*[_type == "mealPlan" && !defined(targetCalories)] | order(_id)[0...101]{_id},"statedNotNumber":count(*[_type == "mealPlan" && defined(targetCalories) && !defined(math::sum([targetCalories]))]),"partsNotNumber":count(*[_type == "mealPlan" && defined(days[].meals[]->calories) && !defined(math::sum(days[].meals[]->calories))]),"mismatched":*[_type == "mealPlan" && defined(targetCalories) && defined(math::sum([targetCalories])) && targetCalories != coalesce(math::sum(days[].meals[]->calories), 0)] | order(_id)[0...101]{_id}}"
    `);
  });

  it("refs: the references and the live ones are counted, the ids of the missing ones come back", () => {
    expect(refsQuery(parseRefsRule("mealPlan:meals"))).toMatchInlineSnapshot(`
      "{"documents":count(*[_type == "mealPlan"]),"broken":*[_type == "mealPlan" && count((meals[])[defined(_ref)]) != count((meals[])[defined(_ref) && defined(@->_id)])] | order(_id)[0...101]{_id,"found":count((meals[])[defined(_ref)]),"live":count((meals[])[defined(_ref) && defined(@->_id)]),"missing":(meals[])[defined(_ref) && !defined(@->_id)][0...11]._ref}}"
    `);
  });

  it("a path that already ends in [] is not given a second one", () => {
    expect(refsQuery(parseRefsRule("mealPlan:days[].meals[]"))).toContain("(days[].meals[])[");
    expect(refsQuery(parseRefsRule("mealPlan:days[].meals[]"))).not.toContain("[][]");
  });

  it("every projection is _id and numbers, and the type is written as a JSON string", () => {
    const queries = [
      totalsQuery(parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories")),
      refsQuery(parseRefsRule("mealPlan:meals")),
    ];
    for (const q of queries) {
      // The only objects the query builds: {_id} and {_id, "found", "live", "missing"}.
      const projections = [...q.matchAll(/\]\s*(?:\|[^{]*)?\{([^}]*)\}/g)].map((m) => m[1]);
      for (const p of projections)
        expect(p, q).toMatch(/^_id(,"found":count\(.*\),"live":count\(.*\),"missing":.*\._ref)?$/);
      expect(q).not.toMatch(/\bname\b|\btitle\b|\bbody\b/);
    }
  });

  it("a rule built by hand is checked again before it is written into a query", () => {
    expect(() =>
      totalsQuery({ type: "mealPlan", stated: 'x == 1] | {"a":title', parts: "days" }),
    ).toThrow(RuleError);
    expect(() => refsQuery({ type: 'a"] | order(x', path: "meals" })).toThrow(RuleError);
  });
});

describe("checkTotals and checkRefs: recorded Sanity responses", () => {
  it("a meal plan stating 2400 whose parts sum to 1830 with 2 unpublished meals: one totals finding and one refs finding on the same document", async () => {
    const { read } = dataset();
    const totals = await checkTotals(
      parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories"),
      read,
    );
    const refs = await checkRefs(parseRefsRule("mealPlan:days[].meals"), read);
    expect(totals.map((f) => [f.checkId, f.url])).toEqual([
      ["generated-total-mismatch", "sanity:mealPlan/plan-heavy-week"],
      ["generated-total-mismatch", "sanity:mealPlan/plan-lean-week"],
      ["generated-total-missing", "sanity:mealPlan/plan-open-week"],
    ]);
    expect(refs.map((f) => [f.checkId, f.url])).toEqual([
      ["generated-ref-unpublished", "sanity:mealPlan/plan-gap-week"],
      ["generated-ref-unpublished", "sanity:mealPlan/plan-lean-week"],
    ]);
    const lean = [...totals, ...refs].filter((f) => f.url === "sanity:mealPlan/plan-lean-week");
    expect(lean.map((f) => f.checkId)).toEqual([
      "generated-total-mismatch",
      "generated-ref-unpublished",
    ]);
    expect(lean[0]).toMatchObject({
      severity: "high",
      title: GENERATED_TITLES.mismatch,
      evidence:
        "mealPlan plan-lean-week: targetCalories does not equal the sum of days[].meals[]->calories.",
    });
    expect(lean[1]).toMatchObject({
      severity: "high",
      title: GENERATED_TITLES.unpublished,
      evidence:
        "mealPlan plan-lean-week: 2 of 5 references at days[].meals point to documents that were never published: meal-tofu-bowl, meal-miso-ramen.",
    });
  });

  it("plans that add up and have every link published produce nothing", async () => {
    const { read } = dataset(
      withDocs({
        meal: [
          { _id: "m1", _type: "meal", calories: 1200 },
          { _id: "m2", _type: "meal", calories: 1200 },
        ],
        mealPlan: [
          {
            _id: "p1",
            _type: "mealPlan",
            targetCalories: 2400,
            days: [{ meals: [{ _ref: "m1" }, { _ref: "m2" }] }],
          },
        ],
      }),
    );
    expect(
      await checkTotals(parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories"), read),
    ).toEqual([]);
    expect(await checkRefs(parseRefsRule("mealPlan:days[].meals"), read)).toEqual([]);
  });

  it("a part that fails to dereference adds nothing to the sum: the missing meal is the shortfall", async () => {
    const { read } = dataset(
      withDocs({
        meal: [{ _id: "m1", _type: "meal", calories: 1200 }],
        mealPlan: [
          {
            _id: "p1",
            _type: "mealPlan",
            targetCalories: 2400,
            days: [{ meals: [{ _ref: "m1" }, { _ref: "m2" }] }],
          },
          // Stating the sum of what exists is not a mismatch; the link is the only problem.
          {
            _id: "p2",
            _type: "mealPlan",
            targetCalories: 1200,
            days: [{ meals: [{ _ref: "m1" }, { _ref: "m2" }] }],
          },
        ],
      }),
    );
    const totals = await checkTotals(
      parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories"),
      read,
    );
    expect(totals.map((f) => f.url)).toEqual(["sanity:mealPlan/p1"]);
    const refs = await checkRefs(parseRefsRule("mealPlan:days[].meals[]"), read);
    expect(refs.map((f) => f.url)).toEqual(["sanity:mealPlan/p1", "sanity:mealPlan/p2"]);
  });

  it("the findings of one document sit together, worst document first", async () => {
    const run = await compareGenerated({
      totals: [parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories")],
      refs: [parseRefsRule("mealPlan:days[].meals")],
      env: ENV,
      fetcher: dataset().fetcher,
      now: NOW,
    });
    expect(run.result.findings.map((f) => `${f.checkId} ${f.url.split("/")[1]}`)).toEqual([
      "generated-total-mismatch plan-heavy-week",
      "generated-total-mismatch plan-lean-week",
      "generated-ref-unpublished plan-lean-week",
      "generated-ref-unpublished plan-gap-week",
      "generated-total-missing plan-open-week",
    ]);
    expect(run.requests).toBe(2);
    expect(run.result.passed).toEqual(["query-type-empty"]);
    expect(() => resultSchema.parse(run.result)).not.toThrow();
  });

  it("groupByDocument keeps a document's own findings in order and the worst document first", () => {
    const f = (checkId: string, severity: "high" | "low", url: string) => ({
      checkId,
      severity,
      title: "t",
      evidence: "e",
      url,
    });
    expect(
      groupByDocument([
        f("a", "low", "x/1"),
        f("b", "high", "x/2"),
        f("c", "high", "x/1"),
        f("d", "low", "x/2"),
      ]).map((g) => g.checkId),
    ).toEqual(["a", "c", "b", "d"]);
  });

  it("a draft is never read: the draft plan with 9999 calories and a dangling link is not reported", async () => {
    const { read } = dataset();
    const all = [
      ...(await checkTotals(
        parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories"),
        read,
      )),
      ...(await checkRefs(parseRefsRule("mealPlan:days[].meals"), read)),
    ];
    expect(all.some((f) => f.url.includes("drafts."))).toBe(false);
    expect(all.some((f) => f.url.includes("plan-draft-week"))).toBe(false);
  });
});

describe("checkTotals and checkRefs: edge cases", () => {
  it("a stated total that is missing is reported as no stated total, low, and not as a mismatch", async () => {
    const { read } = dataset();
    const found = await checkTotals(
      parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories"),
      read,
    );
    const open = found.filter((f) => f.url.endsWith("plan-open-week"));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      checkId: "generated-total-missing",
      severity: "low",
      title: GENERATED_TITLES.unstated,
    });
    expect(open[0]?.evidence).toContain("no stated total");
  });

  it("a stated field that is null counts as missing too", async () => {
    const { read } = dataset(
      withDocs({ mealPlan: [{ _id: "p1", _type: "mealPlan", targetCalories: null, days: [] }] }),
    );
    const found = await checkTotals(
      parseTotalsRule("mealPlan:targetCalories=days[].calories"),
      read,
    );
    expect(found.map((f) => f.checkId)).toEqual(["generated-total-missing"]);
  });

  it("a parts path that resolves to strings is a ConfigError naming the path, and nothing is compared", async () => {
    const { read } = dataset(
      withDocs({
        meal: [{ _id: "m1", _type: "meal", calories: "about 600" }],
        mealPlan: [
          {
            _id: "p1",
            _type: "mealPlan",
            targetCalories: 600,
            days: [{ meals: [{ _ref: "m1" }] }],
          },
        ],
      }),
    );
    const rule = parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories");
    await expect(checkTotals(rule, read)).rejects.toThrow(ConfigError);
    await expect(checkTotals(rule, read)).rejects.toThrow(
      /parts path days\[\]\.meals\[\]->calories ends in something that is not a number on 1 mealPlan document, so nothing was compared/,
    );
  });

  it("a stated field that holds text is a ConfigError naming the field", async () => {
    const { read } = dataset(
      withDocs({ mealPlan: [{ _id: "p1", _type: "mealPlan", targetCalories: "2400", days: [] }] }),
    );
    await expect(
      checkTotals(parseTotalsRule("mealPlan:targetCalories=days[].calories"), read),
    ).rejects.toThrow(/the stated field targetCalories is not a number on 1 mealPlan document/);
  });

  it("a reference to a document that exists only as a draft counts as unpublished", async () => {
    const { read } = dataset(
      withDocs({
        meal: [{ _id: "drafts.m1", _type: "meal", calories: 500 }],
        mealPlan: [{ _id: "p1", _type: "mealPlan", meals: [{ _type: "reference", _ref: "m1" }] }],
      }),
    );
    const found = await checkRefs(parseRefsRule("mealPlan:meals"), read);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toBe(
      "mealPlan p1: 1 of 1 references at meals point to documents that were never published: m1.",
    );
  });

  it("an item with no _ref is not a reference and is not counted", async () => {
    const { read } = dataset(
      withDocs({
        meal: [{ _id: "m1", _type: "meal", calories: 500 }],
        mealPlan: [
          { _id: "p1", _type: "mealPlan", meals: [{ _ref: "m1" }, { _type: "note", text: "x" }] },
        ],
      }),
    );
    expect(await checkRefs(parseRefsRule("mealPlan:meals"), read)).toEqual([]);
  });

  it("0 documents of the type: the query-type-empty finding, and no totals output", async () => {
    const { read } = dataset(withDocs({ meal: [{ _id: "m1", _type: "meal", calories: 1 }] }));
    const totals = await checkTotals(
      parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories"),
      read,
    );
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({ checkId: "query-type-empty", severity: "high" });
    expect(totals[0]?.evidence).toContain("0 published documents");
    const refs = await checkRefs(parseRefsRule("mealPlan:meals"), read);
    expect(refs.map((f) => f.checkId)).toEqual(["query-type-empty"]);
  });

  it("a type that has only drafts is empty too: only published documents count", async () => {
    const { read } = dataset(
      withDocs({
        mealPlan: [{ _id: "drafts.p1", _type: "mealPlan", targetCalories: 5, days: [] }],
      }),
    );
    const found = await checkTotals(
      parseTotalsRule("mealPlan:targetCalories=days[].calories"),
      read,
    );
    expect(found.map((f) => f.checkId)).toEqual(["query-type-empty"]);
  });

  it("decimal parts are a mismatch: 0.1 and 0.2 against 0.3 (store integers in minor units)", async () => {
    const { read } = dataset(
      withDocs({
        line: [
          { _id: "l1", _type: "line", price: 0.1 },
          { _id: "l2", _type: "line", price: 0.2 },
        ],
        invoice: [
          { _id: "i1", _type: "invoice", total: 0.3, lines: [{ _ref: "l1" }, { _ref: "l2" }] },
          { _id: "i2", _type: "invoice", total: 30, lines: [{ _ref: "l3" }, { _ref: "l4" }] },
        ],
      }),
    );
    const found = await checkTotals(parseTotalsRule("invoice:total=lines[]->price"), read);
    expect(found.map((f) => f.url)).toEqual(["sanity:invoice/i1", "sanity:invoice/i2"]);
    // The same amounts in whole minor units add up exactly.
    const { read: cents } = dataset(
      withDocs({
        line: [
          { _id: "l1", _type: "line", price: 10 },
          { _id: "l2", _type: "line", price: 20 },
        ],
        invoice: [
          { _id: "i1", _type: "invoice", total: 30, lines: [{ _ref: "l1" }, { _ref: "l2" }] },
        ],
      }),
    );
    expect(await checkTotals(parseTotalsRule("invoice:total=lines[]->price"), cents)).toEqual([]);
  });

  it("a plan with no parts at all and a stated number above 0 is a mismatch, and 0 against nothing is fine", async () => {
    const { read } = dataset(
      withDocs({
        mealPlan: [
          { _id: "p1", _type: "mealPlan", targetCalories: 2400 },
          { _id: "p2", _type: "mealPlan", targetCalories: 0, days: [] },
        ],
      }),
    );
    const found = await checkTotals(
      parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories"),
      read,
    );
    expect(found.map((f) => f.url)).toEqual(["sanity:mealPlan/p1"]);
  });

  it("more than the listed number of documents is cut, and the last finding says so", async () => {
    const plans = Array.from({ length: 105 }, (_, i) => ({
      _id: `p${String(i).padStart(3, "0")}`,
      _type: "mealPlan",
      targetCalories: 5,
    }));
    const { read } = dataset(withDocs({ mealPlan: plans }));
    const found = await checkTotals(
      parseTotalsRule("mealPlan:targetCalories=days[].calories"),
      read,
    );
    expect(found).toHaveLength(100);
    expect(found[99]?.evidence).toContain("At least 100 documents are listed; there are more.");
    expect(found[98]?.evidence).not.toContain("At least");
  });

  it("ten missing targets are named, and then 'and more'", async () => {
    const refs = Array.from({ length: 14 }, (_, i) => ({
      _ref: `gone-${String(i).padStart(2, "0")}`,
    }));
    const { read } = dataset(
      withDocs({ mealPlan: [{ _id: "p1", _type: "mealPlan", meals: refs }] }),
    );
    const [finding] = await checkRefs(parseRefsRule("mealPlan:meals"), read);
    expect(finding?.evidence).toContain("14 of 14 references");
    expect(finding?.evidence).toContain("gone-09, and more.");
    expect(finding?.evidence).not.toContain("gone-10");
  });

  it("a document id with an invisible character is printed escaped", async () => {
    const { read } = dataset(
      withDocs({ mealPlan: [{ _id: "p​1", _type: "mealPlan", targetCalories: 1 }] }),
    );
    const [finding] = await checkTotals(
      parseTotalsRule("mealPlan:targetCalories=days[].calories"),
      read,
    );
    expect(finding?.evidence).toContain("p\\u{200B}1");
    expect(finding?.url).toContain("p\\u{200B}1");
  });

  it("a question too long for a GET is a ConfigError, not a crash", async () => {
    const tooLong: SanityRead = {
      dataset: "production",
      datasetAssumed: false,
      query: () => Promise.reject(new QueryTooLongError("long")),
    };
    await expect(
      checkTotals(parseTotalsRule("mealPlan:targetCalories=days[].calories"), tooLong),
    ).rejects.toThrow(/too long to send as a GET/);
    await expect(checkRefs(parseRefsRule("mealPlan:meals"), tooLong)).rejects.toThrow(ConfigError);
  });

  it("more than ten rules in one run is a ConfigError before anything is asked", async () => {
    const { seen, fetcher } = dataset();
    const rule = parseRefsRule("mealPlan:days[].meals");
    await expect(
      compareGenerated({ totals: [], refs: Array(11).fill(rule), env: ENV, fetcher, now: NOW }),
    ).rejects.toThrow(/at most 10/);
    expect(seen).toHaveLength(0);
  });
});

describe("the checks", () => {
  it("are three, plus query-type-empty in the registry", () => {
    expect(QUERY_GENERATED_CHECKS.map((c) => c.id)).toEqual([
      "generated-total-mismatch",
      "generated-total-missing",
      "generated-ref-unpublished",
    ]);
    expect(
      createGeneratedRegistry()
        .all()
        .map((c) => c.id),
    ).toEqual([
      "query-type-empty",
      "generated-total-mismatch",
      "generated-total-missing",
      "generated-ref-unpublished",
    ]);
    expect(QUERY_GENERATED_CHECKS.map((c) => c.severity)).toEqual(["high", "low", "high"]);
  });
});

describe("promise: requests are GETs, and ids and numbers are all that come back", () => {
  it("one GET for each rule, published perspective, the token in a header", async () => {
    const { seen, fetcher } = dataset();
    const run = await compareGenerated({
      totals: [
        parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories"),
        parseTotalsRule("mealPlan:targetCalories=days[].meals[]->grams"),
      ],
      refs: [parseRefsRule("mealPlan:days[].meals")],
      env: ENV,
      fetcher,
      now: NOW,
    });
    expect(run.requests).toBe(3);
    expect(seen).toHaveLength(3);
    for (const r of seen) {
      expect(r.method).toBe("GET");
      expect(new URL(r.url).searchParams.get("perspective")).toBe("published");
    }
    expect(seen.map((r) => r.query)).toEqual([
      totalsQuery(parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories")),
      totalsQuery(parseTotalsRule("mealPlan:targetCalories=days[].meals[]->grams")),
      refsQuery(parseRefsRule("mealPlan:days[].meals")),
    ]);
  });

  it("the answers hold ids, counts and references' ids only: no marker text and no stated number", async () => {
    const { bodies, fetcher } = dataset();
    await compareGenerated({
      totals: [parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories")],
      refs: [parseRefsRule("mealPlan:days[].meals")],
      env: ENV,
      fetcher,
      now: NOW,
    });
    expect(bodies).toHaveLength(2);
    const ids = new Set(
      Object.values(mealsContent())
        .flat()
        .map((d) => String(d._id).replace(/^drafts\./, "")),
    );
    const keys = new Set([
      "documents",
      "unstated",
      "statedNotNumber",
      "partsNotNumber",
      "mismatched",
      "broken",
      "_id",
      "found",
      "live",
      "missing",
    ]);
    const seenKeys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v !== null && typeof v === "object")
        return Object.entries(v).forEach(([k, x]) => {
          seenKeys.add(k);
          walk(x);
        });
      // Every string is the id of a document or of a reference's target; every number is a count.
      if (typeof v === "string") expect(ids.has(v) || v === "meal-tofu-bowl", v).toBe(true);
      if (typeof v === "number") expect(Number.isSafeInteger(v)).toBe(true);
    };
    for (const text of bodies) {
      expect(text).not.toContain(MEALS_MARKER);
      const { result } = JSON.parse(text) as { result: unknown };
      walk(result);
      // The stated numbers and the calories are never in an answer: only counts of at most 7.
      for (const n of [2400, 1980, 2000, 1050, 1830, 1650, 9999, 450, 600, 780])
        expect(JSON.stringify(result)).not.toMatch(new RegExp(`\\b${n}\\b`));
    }
    for (const k of seenKeys) expect(keys.has(k), k).toBe(true);
  });

  it("the key never reaches a finding or a message", async () => {
    const token = ["sk", "viewer", "secret"].join("-");
    const spec: FakeSanity = { ...FENNEL_MEALS, token };
    const seen: SeenSanityRequest[] = [];
    const fetcher = createFetcher({
      transport: sanityCountsTransport(spec, seen),
      timeoutMs: 5000,
    });
    const run = await compareGenerated({
      totals: [parseTotalsRule("mealPlan:targetCalories=days[].meals[]->calories")],
      refs: [],
      env: { ...ENV, SANITY_TOKEN: token },
      fetcher,
      now: NOW,
    });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(run)).not.toContain(token);
    expect(seen[0]?.url).not.toContain(token);
  });

  it("a dataset Sanity refuses is a ConfigError (exit 2), not a finding", async () => {
    const fetcher = createFetcher({
      transport: sanityCountsTransport({ ...FENNEL_MEALS, token: "needed" }),
      timeoutMs: 5000,
    });
    await expect(
      compareGenerated({
        totals: [],
        refs: [parseRefsRule("mealPlan:days[].meals")],
        env: ENV,
        fetcher,
        now: NOW,
      }),
    ).rejects.toThrow(/private|refused/);
  });
});
