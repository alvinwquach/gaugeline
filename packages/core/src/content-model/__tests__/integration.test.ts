import { describe, expect, it } from "vitest";
import { FERNBROOK_MARKER } from "../../../../testkit/src/index.js";
import type { SeenSanityRequest } from "../../../../testkit/src/index.js";
import { createPageRegistry } from "../../checks/index.js";
import { MODEL_CHECKS } from "../../presets.js";
import { checkSite } from "../../site.js";
import { HOST, clinicConfig, network, runClinic, type Seen } from "./helpers.js";

/**
 * The acceptance test of X39, against the invented Fernbrook Physio site and dataset: 17 documents
 * missing a new required field, one page showing a raw reference, a listing showing 31 of 48
 * published entries and one dependent block left empty are each found, and so are the fields the
 * schema dropped. The dataset is answered by groq-js over invented documents.
 */
describe("content model checks: the invented clinic site", () => {
  it("finds the 17 documents, the raw reference, the 31 of 48 listing, the empty block and the leftover fields", async () => {
    const queries: SeenSanityRequest[] = [];
    const seen: Seen[] = [];
    const { result } = await runClinic({ queries, seen });
    const by = (id: string) => result.findings.filter((f) => f.checkId === id);

    expect(by("model-missing-required").map((f) => [f.severity, f.evidence])).toEqual([
      [
        "high",
        '17 of 48 published "article" documents have no "summary", which the schema now requires (ids article-32, article-33, article-34, and 14 more)',
      ],
    ]);

    expect(by("model-unexpanded").map((f) => [f.url, f.severity, f.evidence])).toEqual([
      [
        "https://fernbrook.example/services/sports-massage",
        "high",
        '/services/sports-massage shows a raw reference (a _ref id) in its text: "Therapist: {"_type":"reference","_ref":"practitioner-ana"}" (reference id practitioner-ana)',
      ],
    ]);

    expect(by("model-listing-count").map((f) => [f.url, f.severity, f.evidence])).toEqual([
      [
        "https://fernbrook.example/news",
        "high",
        'News shows 31 of 48 published "article" entries (2 pages of results). Not on the page: ids article-32, article-33, article-34, article-35, article-36, article-37, article-38, article-39, article-40, article-41 (the first ten).',
      ],
    ]);

    expect(by("model-dependents").map((f) => [f.url, f.severity, f.evidence])).toEqual([
      [
        "https://fernbrook.example/",
        "medium",
        'Latest from the clinic on / shows no entries (nothing matches "#insights li"), and 48 "article" entries are published',
      ],
    ]);

    expect(by("model-orphan-fields").map((f) => [f.severity, f.evidence])).toEqual([
      [
        "medium",
        '2 of 6 published "practitioner" documents still have a value in "oldSpecialty", which the schema no longer has (ids practitioner-ben, practitioner-dee)',
      ],
      [
        "medium",
        '4 of 9 published "service" documents still have a value in "legacyNote", which the schema no longer has (ids service-01, service-02, service-03, and 1 more)',
      ],
    ]);

    expect(result.couldNotCheck).toEqual([]);

    // Read only, published only, and nothing a client wrote: every request is a GET, every question
    // to Sanity is a count or a list of ids, and no invented text value appears in what was found.
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.method).toBe("GET");
      expect(q.url).toContain("perspective=published");
      expect(q.headers.authorization).toBeUndefined();
      expect(q.query).toMatch(
        /^(?:\{.*\}|count\(.*\)|\*\[.*\]\|order\(_id\)\[0\.\.\.\d+\]\._id)$/s,
      );
      expect(q.query).not.toMatch(/\{\s*_id|\{\s*title|\[0\](?!\.\.\.)/);
    }
    expect(JSON.stringify(result)).not.toContain(FERNBROOK_MARKER);
  });

  it("without the id page declared, the id shown on purpose is reported too", async () => {
    const { idsShownOn: _unused, ...rest } = clinicConfig();
    const { result } = await runClinic({ config: rest, only: ["model-unexpanded"] });
    expect(
      result.findings.filter((f) => f.url.endsWith("/dev/content-ids")).map((f) => f.evidence),
    ).toEqual([
      '/dev/content-ids shows a raw reference (a _ref id) in its text: "quote its id, for example _ref: practitioner-ana." (reference id practitioner-ana)',
    ]);
  });

  it("without a schema file or a Sanity project, the schema and dataset checks say so and the page checks still run", async () => {
    const { result } = await runClinic({ schema: false, env: {} });
    expect(new Set(result.findings.map((f) => f.checkId))).toEqual(new Set(["model-unexpanded"]));
    const unchecked = Object.fromEntries(result.couldNotCheck.map((c) => [c.id, c.reason]));
    expect(Object.keys(unchecked).sort()).toEqual([
      "model-dependents",
      "model-listing-count",
      "model-missing-required",
      "model-orphan-fields",
    ]);
    expect(unchecked["model-missing-required"]).toContain('"schema"');
    expect(unchecked["model-orphan-fields"]).toContain('"schema"');
    expect(unchecked["model-listing-count"]).toContain("SANITY_PROJECT_ID is not set");
    // Nothing that was not looked at is passed.
    expect(result.passed).not.toContain("model-missing-required");
    expect(result.passed).not.toContain("model-listing-count");
  });

  it("does not run at all without gaugeline.model.json: not found, not passed, not could-not-check", async () => {
    const { result } = await checkSite({
      address: `https://${HOST}/`,
      fetcher: network(),
      registry: createPageRegistry(),
    });
    const ours = (id: string) => MODEL_CHECKS.includes(id);
    expect(result.findings.filter((f) => ours(f.checkId))).toEqual([]);
    expect(result.passed.filter(ours)).toEqual([]);
    expect(result.couldNotCheck.filter((c) => ours(c.id))).toEqual([]);
  });
});
