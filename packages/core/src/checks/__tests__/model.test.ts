import { afterEach, describe, expect, it } from "vitest";
import {
  FERNBROOK_MARKER,
  fernbrookContent,
  type FakeSanity,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import {
  PROJECT,
  clinicConfig,
  network,
  runClinic,
} from "../../content-model/__tests__/helpers.js";
import { modelConfigSchema, type ModelConfig } from "../../content-model/config.js";
import { createContentModel } from "../../content-model/read.js";
import { createStatePages } from "../../switches/pages.js";
import { createBudget } from "../../limits.js";
import { buildSnapshot } from "../../snapshot.js";
import { modelDependents } from "../model-dependents.js";
import { modelListingCount } from "../model-listing-count.js";
import { MODEL_CHECKS } from "../../presets.js";

const without = (config: ModelConfig, ...keys: (keyof ModelConfig)[]): ModelConfig => {
  const copy: Record<string, unknown> = { ...config };
  for (const k of keys) delete copy[k];
  return copy as ModelConfig;
};

describe("model-missing-required: edge cases", () => {
  it("a field required only for some document types is judged on those types", async () => {
    // Nine services and six practitioners have no `summary`, but only the article type requires it.
    const { result } = await runClinic({ only: ["model-missing-required"] });
    expect(result.findings.map((f) => f.evidence)).toHaveLength(1);
    expect(result.findings[0]?.evidence).toContain('"article" documents have no "summary"');
  });

  it("leaves unpublished drafts out of the count, and says nothing when nothing is missing", async () => {
    const sanity: FakeSanity = { types: {}, content: fernbrookContent() };
    for (const d of sanity.content!.article ?? [])
      if (!("summary" in d))
        (d as Record<string, unknown>).summary = `${FERNBROOK_MARKER} filled in`;
    const { result } = await runClinic({ sanity, only: ["model-missing-required"] });
    expect(result.findings).toEqual([]);
    expect(result.passed).toContain("model-missing-required");
  });

  it("does not report a draft that is missing a field when its published twin has it", async () => {
    const content = fernbrookContent();
    content.article = [
      ...(content.article ?? []),
      { _id: "drafts.article-01", _type: "article", title: "x" },
    ];
    const { result } = await runClinic({
      sanity: { types: {}, content },
      only: ["model-missing-required"],
    });
    expect(result.findings[0]?.evidence).toContain("17 of 48");
  });

  it("is the same on every run", async () => {
    const a = await runClinic({ only: ["model-missing-required"] });
    const b = await runClinic({ only: ["model-missing-required"] });
    expect(a.result.findings).toEqual(b.result.findings);
  });
});

describe("model-listing-count: edge cases", () => {
  it("a listing that legitimately filters out some entries, declared in the config, is not reported", async () => {
    const config = modelConfigSchema.parse({
      listings: [
        {
          name: "News",
          page: "/news",
          type: "article",
          filter: "defined(summary)",
          item: "article.card",
        },
      ],
    });
    const { result } = await runClinic({ config, only: ["model-listing-count"] });
    expect(result.findings).toEqual([]);
    expect(result.passed).toContain("model-listing-count");
  });

  it("a filter that is not GROQ is could not check, with Sanity's refusal, not a finding", async () => {
    const config = modelConfigSchema.parse({
      listings: [{ page: "/news", type: "article", filter: "== == ==", item: "article.card" }],
    });
    const { result } = await runClinic({ config, only: ["model-listing-count"] });
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck).toHaveLength(1);
    expect(result.couldNotCheck[0]?.reason).toContain("could not be counted");
    expect(result.passed).not.toContain("model-listing-count");
  });

  it("a listing page that does not exist is could not check", async () => {
    const config = modelConfigSchema.parse({
      listings: [{ page: "/blog", type: "article", item: "li" }],
    });
    const { result } = await runClinic({ config, only: ["model-listing-count"] });
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck[0]?.reason).toBe(
      'The listing "/blog" was not counted: /blog answers 404.',
    );
  });

  it("an item selector that matches nothing shows 0 of 48, so a wrong selector is seen", async () => {
    const config = modelConfigSchema.parse({
      listings: [{ page: "/news", type: "article", item: "li.card" }],
    });
    const { result } = await runClinic({ config, only: ["model-listing-count"] });
    expect(result.findings[0]?.evidence).toContain("/news shows 0 of 48 published");
  });

  it("with no listing named it says so", async () => {
    const { result } = await runClinic({
      config: without(clinicConfig(), "listings"),
      only: ["model-listing-count"],
    });
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck[0]?.reason).toContain('under "listings"');
  });

  it("when every published address is on the page but there are more documents, it says two share an address", async () => {
    // 32 published articles, and article-32 has article-01's slug: the page shows 31 distinct entries.
    const content = fernbrookContent();
    const articles = (content.article ?? []).filter(
      (d) => Number(String(d._id).replace(/\D/g, "")) <= 32,
    );
    (articles.find((d) => d._id === "article-32") as { slug: { current: string } }).slug.current =
      "tip-01";
    const { result } = await runClinic({
      sanity: { types: {}, content: { ...content, article: articles } },
      only: ["model-listing-count"],
    });
    expect(result.findings[0]?.evidence).toContain("shows 31 of 32");
    expect(result.findings[0]?.evidence).toContain("some documents share an address");
  });
});

describe("model-unexpanded: edge cases", () => {
  it("a page that shows an id on purpose is skipped by the exact path or by a pattern", async () => {
    for (const idsShownOn of [["/dev/content-ids"], ["/dev/*"], ["/dev/content-ids/", "/other"]]) {
      const { result } = await runClinic({
        config: { ...clinicConfig(), idsShownOn },
        only: ["model-unexpanded"],
      });
      expect(result.findings.map((f) => new URL(f.url).pathname)).toEqual([
        "/services/sports-massage",
      ]);
    }
  });
});

describe("the dataset and the token", () => {
  const TOKEN = ["sk", "fernbrook", "token", "0123456789abcdef"].join("_");
  const privateDataset: FakeSanity = { types: {}, content: fernbrookContent(), token: TOKEN };

  it("a private dataset with no token is could not check and says how to give one, never a finding", async () => {
    const { result } = await runClinic({
      sanity: privateDataset,
      only: ["model-missing-required"],
    });
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck[0]?.reason).toContain("Viewer role");
    expect(result.passed).not.toContain("model-missing-required");
  });

  it("with a token it reads the dataset, sends the token in a header and never prints it", async () => {
    const queries: SeenSanityRequest[] = [];
    const { result } = await runClinic({
      sanity: privateDataset,
      queries,
      env: { SANITY_PROJECT_ID: PROJECT, SANITY_TOKEN: TOKEN },
      only: ["model-missing-required"],
    });
    expect(result.findings).toHaveLength(1);
    expect(queries.every((q) => q.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(queries.every((q) => !q.url.includes(TOKEN))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("a Sanity project id that is not one is could not check with the connector's own wording", async () => {
    const { result } = await runClinic({
      env: { SANITY_PROJECT_ID: "NOT A PROJECT" },
      only: ["model-missing-required"],
    });
    expect(result.couldNotCheck[0]?.reason).toContain("is not a Sanity project id");
  });
});

describe("model-dependents: edge cases", () => {
  it("a block that shows entries is not reported", async () => {
    const config = modelConfigSchema.parse({
      dependents: [{ page: "/", selector: "main h1", type: "article" }],
    });
    const { result } = await runClinic({ config, only: ["model-dependents"] });
    expect(result.findings).toEqual([]);
    expect(result.passed).toContain("model-dependents");
  });

  it("an empty block is not reported when the type has no published documents to show", async () => {
    const { result } = await runClinic({
      sanity: { types: {}, content: { article: [] } },
      only: ["model-dependents"],
    });
    expect(result.findings).toEqual([]);
    expect(result.passed).toContain("model-dependents");
  });

  it("the filter narrows what the block could show", async () => {
    const config = modelConfigSchema.parse({
      dependents: [
        { page: "/", selector: "#insights li", type: "article", filter: "archived == true" },
      ],
    });
    const { result } = await runClinic({ config, only: ["model-dependents"] });
    expect(result.findings).toEqual([]);
  });

  it("with --since last it says how many entries the block had last run", async () => {
    const config = modelConfigSchema.parse({
      dependents: [
        { page: "/", selector: "#insights li", type: "article", block: "Latest from the clinic" },
      ],
    });
    const fetcher = network();
    const hops = await fetcher.get("https://fernbrook.example/");
    const snapshot = buildSnapshot(hops);
    const ctx = {
      warn: () => undefined,
      couldNotCheck: () => undefined,
      model: createContentModel({ config, env: { SANITY_PROJECT_ID: PROJECT } }, fetcher),
      statePages: createStatePages({ fetcher, budget: createBudget(), known: [snapshot] }),
      previous: {
        schema: 1 as const,
        url: snapshot.finalUrl,
        takenAt: "2026-11-09T09:00:00.000Z",
        prices: {},
        forms: {},
        pages: {
          "/": {
            url: snapshot.finalUrl,
            words: 100,
            headings: [],
            sections: [],
            links: 0,
            images: 0,
            lists: [{ key: "Latest from the clinic", items: 6, links: [], paginated: false }],
            types: [],
          },
        },
      },
    };
    const found = await modelDependents.run(snapshot, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toMatch(/; the last run listed 6$/);
  });
});

describe("the checks that need a file", () => {
  it("asked for by id without gaugeline.model.json, each says it could not check", async () => {
    const snapshot = buildSnapshot(await network().get("https://fernbrook.example/"));
    const notes: string[] = [];
    const ctx = {
      warn: () => undefined,
      couldNotCheck: (_: string, why: string) => void notes.push(why),
    };
    expect(await modelListingCount.run(snapshot, ctx)).toEqual([]);
    expect(await modelDependents.run(snapshot, ctx)).toEqual([]);
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.startsWith("gaugeline.model.json is not set up"))).toBe(true);
    expect(MODEL_CHECKS).toHaveLength(5);
  });
});

afterEach(() => undefined);
