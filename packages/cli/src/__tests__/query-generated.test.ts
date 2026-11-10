import { fileURLToPath } from "node:url";
import {
  FENNEL_MEALS,
  MEALS_MARKER,
  sanityCountsTransport,
  type FakeSanity,
  type SeenSanityRequest,
} from "@gaugeline/testkit";
import { resultSchema } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";

const repo = fileURLToPath(new URL("../../../fixtures/repo-meals/", import.meta.url));
const ENV = { SANITY_PROJECT_ID: "fennel1", SANITY_DATASET: "production" };
const TOTALS = "mealPlan:targetCalories=days[].meals[]->calories";
const REFS = "mealPlan:days[].meals";

async function query(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    spec?: FakeSanity;
    seen?: SeenSanityRequest[];
    cwd?: string;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["query", ...argv],
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: options.env ?? ENV,
    },
    {
      cwd: options.cwd ?? repo,
      now: () => new Date("2026-11-10T12:00:00Z"),
      fetcher: {
        transport: sanityCountsTransport(options.spec ?? FENNEL_MEALS, options.seen ?? []),
        timeoutMs: 5000,
      },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

const EXPECTED = [
  "Asked the dataset about 1 --totals rule and 1 --refs rule: one request each, published documents only. The dataset did the comparing and sent back ids and counts, so no stated number, part or other field was read.",
  "",
  "\u2717 A stated total is not the sum of its parts",
  "    mealPlan plan-heavy-week: targetCalories does not equal the sum of days[].meals[]->calories.",
  "\u2717 A stated total is not the sum of its parts",
  "    mealPlan plan-lean-week: targetCalories does not equal the sum of days[].meals[]->calories.",
  "\u2717 A document links to something that was never published",
  "    mealPlan plan-lean-week: 2 of 5 references at days[].meals point to documents that were never published: meal-tofu-bowl, meal-miso-ramen.",
  "\u2717 A document links to something that was never published",
  "    mealPlan plan-gap-week: 1 of 3 references at days[].meals point to documents that were never published: meal-tofu-bowl.",
  "\u00B7 A document has no stated total",
  "    mealPlan plan-open-week: no stated total, so targetCalories was not compared with the sum of days[].meals[]->calories.",
  "\u2713 query-type-empty",
  "",
  "5 to look at, 4 to fix first.",
  "",
].join("\n");

describe("gaugeline query --totals --refs: end to end", () => {
  it("both flags in one command: the output, with each plan's findings together", async () => {
    const r = await query(["./src", "--totals", TOTALS, "--refs", REFS]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    expect(r.out).toBe(EXPECTED);
  });

  it("with --ci it exits 1: a total that does not add up is a fix-first finding", async () => {
    const r = await query(["./src", "--totals", TOTALS, "--refs", REFS, "--ci"]);
    expect(r.code).toBe(EXIT.findings);
    expect(r.out).toBe(EXPECTED);
  });

  it("--totals alone, or --refs alone, runs just that rule", async () => {
    const seen: SeenSanityRequest[] = [];
    const totals = await query(["./src", "--totals", TOTALS], { seen });
    expect(totals.out).toContain("1 --totals rule:");
    expect(totals.out).not.toContain("never published");
    expect(seen).toHaveLength(1);
    const refs = await query(["./src", "--refs", REFS], { seen });
    expect(refs.out).toContain("1 --refs rule:");
    expect(refs.out).not.toContain("stated total");
    expect(seen).toHaveLength(2);
  });

  it("--json prints the result, with the same findings in the same order", async () => {
    const r = await query(["./src", "--totals", TOTALS, "--refs", REFS, "--json"]);
    const result = resultSchema.parse(JSON.parse(r.out));
    expect(result.findings.map((f) => [f.checkId, f.severity, f.url])).toEqual([
      ["generated-total-mismatch", "high", "sanity:mealPlan/plan-heavy-week"],
      ["generated-total-mismatch", "high", "sanity:mealPlan/plan-lean-week"],
      ["generated-ref-unpublished", "high", "sanity:mealPlan/plan-lean-week"],
      ["generated-ref-unpublished", "high", "sanity:mealPlan/plan-gap-week"],
      ["generated-total-missing", "low", "sanity:mealPlan/plan-open-week"],
    ]);
  });

  it("both flags repeat: one GET for each rule, and a plan that adds up is not in the output", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await query(
      [
        "./src",
        "--totals",
        TOTALS,
        "--totals",
        "mealPlan:targetCalories=days[].meals[]->calories",
        "--totals",
        "mealPlan:targetCalories=days[].meals[]->grams",
        "--refs",
        REFS,
        "--refs",
        "mealPlan:swaps",
      ],
      { seen },
    );
    expect(r.code).toBe(EXIT.ok);
    // The rule given twice is asked once: 2 different --totals rules and 2 different --refs rules.
    expect(seen).toHaveLength(4);
    expect(r.out).toContain("2 --totals rules and 2 --refs rules");
    expect(r.out).not.toContain(
      "plan-steady-week: targetCalories does not equal the sum of days[].meals[]->calories",
    );
  });

  it("a type with no documents: the query-type-empty finding and no totals", async () => {
    const r = await query(["./src", "--totals", "dinnerParty:total=courses[].price"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("A document type your query asks for has no documents");
    expect(r.out).toContain(
      "--totals dinnerParty:total=courses[].price  Nothing of type dinnerParty exists",
    );
    expect(r.out).not.toContain("stated total");
  });

  it("a parts path that resolves to text is exit 2, naming the path", async () => {
    const r = await query(["./src", "--totals", "mealPlan:targetCalories=title"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain(
      "the parts path title ends in something that is not a number on 5 mealPlan documents",
    );
    expect(r.out).toBe("");
  });

  it("--ci with nothing wrong exits 0", async () => {
    const spec: FakeSanity = {
      types: {},
      content: {
        meal: [{ _id: "m1", _type: "meal", calories: 5 }],
        mealPlan: [
          { _id: "p1", _type: "mealPlan", targetCalories: 5, days: [{ meals: [{ _ref: "m1" }] }] },
        ],
      },
    };
    const r = await query(["./src", "--totals", TOTALS, "--refs", REFS, "--ci"], { spec });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Nothing to look at.");
  });
});

describe("gaugeline query --totals --refs: what it never does", () => {
  it("sends only GETs, one for each rule, and nothing from a document reaches the output", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await query(["./src", "--totals", TOTALS, "--refs", REFS], { seen });
    expect(seen).toHaveLength(2);
    expect(seen.every((q) => q.method === "GET")).toBe(true);
    expect(r.out + r.err).not.toContain(MEALS_MARKER);
    // The stated numbers and the sums are not in the output either.
    for (const n of ["2400", "1830", "2000", "1650", "1980"]) expect(r.out).not.toContain(n);
  });

  it("the token goes in a header and never into the address or the output", async () => {
    const token = ["sk", "viewer", "secret"].join("-");
    const seen: SeenSanityRequest[] = [];
    const r = await query(["./src", "--refs", REFS, "--json"], {
      env: { ...ENV, SANITY_TOKEN: token },
      spec: { ...FENNEL_MEALS, token },
      seen,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(seen[0]?.url).not.toContain(token);
    expect(r.out + r.err).not.toContain(token);
  });
});

describe("gaugeline query --totals --refs: a rule that is wrong", () => {
  it("is exit 2 with the character it went wrong at, and nothing is asked", async () => {
    const seen: SeenSanityRequest[] = [];
    const r = await query(["./src", "--totals", "mealPlan:targetCalories days[].calories"], {
      seen,
    });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain(
      'an "=" is missing between the stated field and its parts (character 40)',
    );
    expect(r.err).toContain('--totals "mealPlan:targetCalories days[].calories"');
    expect(seen).toHaveLength(0);
    expect(r.out).toBe("");
  });

  it("a quote in a field name is exit 2 for --refs too", async () => {
    const r = await query(["./src", "--refs", 'mealPlan:me"als']);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("(character 12)");
  });

  it("more than ten rules is exit 2 before anything is asked", async () => {
    const seen: SeenSanityRequest[] = [];
    const argv = ["./src"];
    for (let i = 0; i < 6; i++) argv.push("--totals", `mealPlan:t${i}=days[].m${i}`);
    for (let i = 0; i < 5; i++) argv.push("--refs", `mealPlan:r${i}`);
    const r = await query(argv, { seen });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("11 rules were given, and a run takes at most 10");
    expect(seen).toHaveLength(0);
  });

  it("needs SANITY_PROJECT_ID, and a folder that exists", async () => {
    const noEnv = await query(["./src", "--refs", REFS], { env: {} });
    expect(noEnv.code).toBe(EXIT.couldNotRun);
    expect(noEnv.err).toContain("SANITY_PROJECT_ID");
    const noFolder = await query(["./nowhere", "--refs", REFS]);
    expect(noFolder.code).toBe(EXIT.couldNotRun);
    expect(noFolder.err).toContain("does not exist");
  });
});

describe("gaugeline query --totals --refs: the flags", () => {
  const parse = (argv: string[]) => parseCliArgs(["query", ...argv]);

  it("are parsed as their own run, with the rules as typed", () => {
    expect(parse(["./src", "--totals", TOTALS, "--totals", "a:b=c", "--refs", REFS])).toMatchObject(
      {
        kind: "query",
        dir: "./src",
        generated: { totals: [TOTALS, "a:b=c"], refs: [REFS] },
        dupes: false,
        mutations: false,
      },
    );
  });

  it("need one folder and refuse the other runs and --schema", () => {
    for (const argv of [
      ["--refs", REFS],
      ["./src", "./more", "--refs", REFS],
      ["./src", "--refs", REFS, "--graphql"],
      ["./src", "--refs", REFS, "--dupes"],
      ["./src", "--totals", TOTALS, "--mutations"],
      ["./src", "--totals", TOTALS, "--unused"],
      ["./src", "--refs", REFS, "--suggest", "--type", "post"],
      ["--refs", REFS, "--page", "--type", "post", "--out", "./x"],
      ["./src", "--refs", REFS, "--schema", "schema.json"],
    ])
      expect(parse(argv).kind, argv.join(" ")).toBe("error");
  });

  it("are in --help and in the flag list, for query only", () => {
    expect(HELP.query).toContain("--totals");
    expect(HELP.query).toContain("--refs");
    for (const name of ["totals", "refs"]) {
      const flag = FLAGS.find((f) => f.name === name);
      expect(flag?.commands).toEqual(["query"]);
      expect(flag?.multiple).toBe(true);
    }
  });

  it("are not flags of the other commands", () => {
    expect(parseCliArgs(["https://example.com", "--totals", TOTALS]).kind).toBe("error");
  });
});
