import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toLeaksModel, type LeaksModel } from "../model";
import { result } from "../../__tests__/helpers";
import {
  DATASET_IDS,
  ELLIPSIS,
  MASKED,
  PLANTED_KEY,
  keyFinding,
  publicDataset,
  SIX_TYPES,
  script,
  withLeaks,
} from "./helpers";
import { finding } from "../../__tests__/helpers";

/** Everything the three panels need ran and passed, unless a test says otherwise. */
const allRan = [...DATASET_IDS, "secret-in-js", "temp-host-links", "temp-host-canonical"];

describe("toLeaksModel: no Sanity", () => {
  const model = toLeaksModel(
    result({ passed: [...allRan, "staging-indexable"] }),
    withLeaks({ datasets: [], scripts: [], previews: [] }),
  );

  it("says the site does not use Sanity, with nothing to list", () => {
    expect(model.dataset.availability).toEqual({ ran: true });
    expect(model.dataset.datasets).toEqual([]);
    expect(model.scripts.rows).toEqual([]);
    expect(model.staging.rows).toEqual([]);
  });
});

describe("toLeaksModel: a private dataset", () => {
  const model = toLeaksModel(
    result({ passed: allRan }),
    withLeaks({
      datasets: [{ projectId: "ab12cd34", dataset: "production", state: "private" }],
      scripts: [],
      previews: [],
    }),
  );

  it("is private, with no document count and no type names", () => {
    expect(model.dataset.datasets).toEqual([
      {
        projectId: "ab12cd34",
        dataset: "production",
        visibility: "private",
        documentCount: null,
        types: [],
        findings: [],
      },
    ]);
  });
});

describe("toLeaksModel: a public dataset with 6 types", () => {
  const f = finding({
    checkId: "dataset-public",
    severity: "low",
    evidence:
      'project ab12cd34, dataset "production": 412 documents in 6 types (author, category, page and 3 more) answer without a token',
  });
  const other = finding({ checkId: "canonical-elsewhere" });
  const model = toLeaksModel(
    result({ findings: [other, f], passed: allRan.filter((i) => i !== "dataset-public") }),
    withLeaks({ datasets: [publicDataset()], scripts: [], previews: [] }),
  );

  it("lists the six type names and the document count, and links the finding by its place in the result", () => {
    const [d] = model.dataset.datasets ?? [];
    expect(d?.visibility).toBe("public");
    expect(d?.types).toEqual(SIX_TYPES);
    expect(d?.documentCount).toBe(412);
    expect(d?.findings).toEqual([1]);
  });

  it("keeps the type names in the order the server gave them", () => {
    expect(model.dataset.datasets?.[0]?.types).toEqual([...SIX_TYPES]);
  });
});

describe("toLeaksModel: a key found in one of 15 files", () => {
  const files = Array.from({ length: 15 }, (_, i) => script(`/assets/chunk-${i + 1}.js`));
  const hit = keyFinding("/assets/chunk-7.js");
  const model = toLeaksModel(
    result({
      findings: [finding({ checkId: "canonical-elsewhere" }), hit],
      passed: allRan.filter((i) => i !== "secret-in-js"),
      sampled: { scripts: { seen: 15, taken: 15, limit: 15 } },
    }),
    withLeaks({ datasets: [], scripts: files, previews: [] }),
  );

  it("has one row for each file, in the order scanned", () => {
    expect(model.scripts.rows.map((r) => r.address)).toEqual(files.map((f) => f.where));
    expect(model.scripts.scanned).toBe(15);
    expect(model.scripts.limit).toBe(15);
    expect(model.scripts.notScanned).toBe(0);
  });

  it("puts the key kind, the masked value and the finding's place on the file that has it, and nothing on the others", () => {
    const rows = model.scripts.rows;
    expect(rows[6]?.keys).toEqual([{ kind: "Stripe secret key", masked: MASKED, finding: 1 }]);
    expect(rows.filter((r) => r.keys.length > 0)).toHaveLength(1);
    expect(rows.filter((r) => r.state === "scanned")).toHaveLength(15);
  });

  it("never holds the full key anywhere in the model", () => {
    expect(JSON.stringify(model)).not.toContain(PLANTED_KEY);
  });
});

describe("toLeaksModel: a staging copy that answers", () => {
  const f = finding({
    checkId: "staging-indexable",
    severity: "high",
    evidence:
      "https://staging.shop.example/ answers 200 with no noindex in meta robots or X-Robots-Tag",
  });
  const model = toLeaksModel(
    result({ findings: [f], passed: allRan }),
    withLeaks({ datasets: [], scripts: [], previews: [] }),
  );

  it("names the address, says it answers publicly and links the finding", () => {
    expect(model.staging.rows).toEqual([
      expect.objectContaining({
        address: "https://staging.shop.example/",
        kind: "staging-host",
        reachable: "yes",
        finding: 0,
      }),
    ]);
  });
});

describe("toLeaksModel: staging from the request log and preview links", () => {
  const checked = withLeaks(
    { datasets: [], scripts: [], previews: ["https://shop-git-main.vercel.app/classes"] },
    {
      requests: [
        {
          url: "https://staging.shop.example/",
          kind: "other",
          method: "GET",
          status: 401,
          ms: 4,
        },
      ],
    },
  );
  const links = finding({
    checkId: "temp-host-links",
    evidence: "1 link to a temporary address: https://shop-git-main.vercel.app/classes",
  });
  const model = toLeaksModel(
    result({ findings: [links], passed: [...DATASET_IDS, "secret-in-js", "staging-indexable"] }),
    checked,
  );

  it("lists a preview link as not requested, and a staging address that asks for a login as not public", () => {
    const byKind = Object.fromEntries(model.staging.rows.map((r) => [r.kind, r]));
    expect(byKind["preview-link"]).toMatchObject({
      address: "https://shop-git-main.vercel.app/classes",
      reachable: "unknown",
      finding: 0,
    });
    expect(byKind["staging-host"]).toMatchObject({
      address: "https://staging.shop.example/",
      reachable: "no",
    });
    expect(byKind["staging-host"]?.answer).toContain("login");
  });
});

describe("toLeaksModel: a check that did not run", () => {
  it("gives the reason in the result, and no rows", () => {
    const model = toLeaksModel(
      result({
        couldNotCheck: [
          {
            id: "secret-in-js",
            reason: "the page refused the request (status 403)",
            url: "https://shop.example/",
          },
          ...DATASET_IDS.map((id) => ({
            id,
            reason: "the page refused the request (status 403)",
            url: "https://shop.example/",
          })),
        ],
      }),
      withLeaks({ previews: [] }),
    );
    expect(model.scripts.availability).toEqual({
      ran: false,
      reason: "the page refused the request (status 403)",
    });
    expect(model.dataset.availability.ran).toBe(false);
    expect(model.scripts.rows).toEqual([]);
    expect(model.dataset.datasets).toEqual([]);
  });

  it("a check that failed, or is in no list, is not described as passed", () => {
    const model = toLeaksModel(result({ failed: ["secret-in-js"] }), undefined);
    expect(model.scripts.availability.ran).toBe(false);
    expect(model.dataset.availability.ran).toBe(false);
    expect(model.staging.availability.ran).toBe(false);
  });

  it("one staging check that could not run is noted while the others show their rows", () => {
    const model = toLeaksModel(
      result({
        passed: ["temp-host-links", "temp-host-canonical"],
        couldNotCheck: [
          {
            id: "staging-indexable",
            reason: "no names are looked up",
            url: "https://shop.example/",
          },
        ],
      }),
      withLeaks({ previews: [] }),
    );
    expect(model.staging.availability).toEqual({ ran: true });
    expect(model.staging.notes).toEqual(["no names are looked up"]);
  });
});

describe("toLeaksModel: when the server sent no leaks data", () => {
  it("keeps what the findings say and marks the lists as not kept", () => {
    const model = toLeaksModel(
      result({ findings: [keyFinding("/assets/app.js")], passed: allRan }),
      undefined,
    );
    expect(model.kept).toBe(false);
    expect(model.scripts.rows).toHaveLength(1);
    expect(model.scripts.rows[0]?.address).toBe("/assets/app.js");
    expect(model.scripts.rows[0]?.keys).toHaveLength(1);
  });
});

describe("toLeaksModel: edge cases", () => {
  it("more than 15 files on the page: the rows are the 15 scanned, and the rest are counted", () => {
    const files = Array.from({ length: 15 }, (_, i) => script(`/a/${i}.js`));
    const model = toLeaksModel(
      result({
        passed: allRan,
        sampled: { scripts: { seen: 22, taken: 15, limit: 15 } },
      }),
      withLeaks({ datasets: [], scripts: files, previews: [] }),
    );
    expect(model.scripts.rows).toHaveLength(15);
    expect(model.scripts.scanned).toBe(15);
    expect(model.scripts.notScanned).toBe(7);
  });

  it("two keys in one file: two entries, each with its own finding", () => {
    const a = keyFinding("/assets/app.js", 40);
    const b = keyFinding("/assets/app.js", 900, `rk_liv${ELLIPSIS}7Q`);
    const model = toLeaksModel(
      result({ findings: [a, b], passed: allRan.filter((i) => i !== "secret-in-js") }),
      withLeaks({ datasets: [], scripts: [script("/assets/app.js")], previews: [] }),
    );
    const [row] = model.scripts.rows;
    expect(row?.keys.map((k) => k.finding)).toEqual([0, 1]);
    expect(row?.keys.map((k) => k.masked)).toEqual([MASKED, `rk_liv${ELLIPSIS}7Q`]);
  });

  it("a key in an inline script gets its own row", () => {
    const model = toLeaksModel(
      result({
        findings: [keyFinding("inline script 2 on /checkout")],
        passed: allRan.filter((i) => i !== "secret-in-js"),
      }),
      withLeaks({ datasets: [], scripts: [script("/assets/app.js")], previews: [] }),
    );
    expect(model.scripts.rows.map((r) => r.address)).toEqual([
      "/assets/app.js",
      "inline script 2 on /checkout",
    ]);
    expect(model.scripts.rows[1]?.keys).toHaveLength(1);
  });

  it("a file that did not load is not scanned and never says nothing was found", () => {
    const model = toLeaksModel(
      result({ passed: allRan }),
      withLeaks({
        datasets: [],
        scripts: [
          script("/missing.js", { status: 404 }),
          script("/slow.js", { status: null }),
          script("/big.js", { truncated: true }),
        ],
        previews: [],
      }),
    );
    expect(model.scripts.rows.map((r) => r.state)).toEqual([
      "not-scanned",
      "not-scanned",
      "partial",
    ]);
    expect(model.scripts.scanned).toBe(1);
    expect(model.scripts.rows[0]?.note).toContain("404");
  });

  it("a value in the finding that is longer than a mask is cut to one", () => {
    const model = toLeaksModel(
      result({
        findings: [keyFinding("/assets/app.js", 1, PLANTED_KEY)],
        passed: allRan.filter((i) => i !== "secret-in-js"),
      }),
      withLeaks({ datasets: [], scripts: [script("/assets/app.js")], previews: [] }),
    );
    const masked = model.scripts.rows[0]?.keys[0]?.masked ?? "";
    expect(masked).not.toBe(PLANTED_KEY);
    expect(masked.length).toBeLessThanOrEqual(9);
    expect(JSON.stringify(model)).not.toContain(PLANTED_KEY);
  });

  it("a dataset with 200 types keeps all 200 in order", () => {
    const types = Array.from({ length: 200 }, (_, i) => `type${String(i).padStart(3, "0")}`);
    const model = toLeaksModel(
      result({ passed: allRan }),
      withLeaks({ datasets: [publicDataset({ types, count: 5000 })], scripts: [], previews: [] }),
    );
    expect(model.dataset.datasets[0]?.types).toEqual(types);
  });
});

/** Every key of an object, at any depth. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  return into;
}

describe("the model has no field that could carry a document or a key", () => {
  const FORBIDDEN = ["content", "contents", "documents", "body", "text", "secret", "key", "value"];

  it("no output has a field named content, documents or body", () => {
    const models: LeaksModel[] = [
      toLeaksModel(
        result({ passed: allRan }),
        withLeaks({
          datasets: [publicDataset()],
          scripts: [script("/a.js")],
          previews: ["https://x.vercel.app/"],
        }),
      ),
      toLeaksModel(
        result({ findings: [keyFinding("/a.js")] }),
        withLeaks({ datasets: [], scripts: [script("/a.js")], previews: [] }),
      ),
    ];
    for (const m of models) {
      const keys = keysOf(m);
      for (const bad of FORBIDDEN) expect(keys.has(bad), bad).toBe(false);
    }
  });

  it("the model's source declares no property with those names", () => {
    const source = readFileSync(fileURLToPath(new URL("../model.ts", import.meta.url)), "utf8");
    for (const bad of ["content", "documents", "body"])
      expect(new RegExp(`\\b${bad}\\s*\\??\\s*:`).test(source), bad).toBe(false);
  });
});
