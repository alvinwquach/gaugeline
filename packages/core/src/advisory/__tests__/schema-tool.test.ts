import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildSchemaText, checkSchemaDir } from "../../../../../scripts/lib/schema.js";
import { RESULT_SCHEMA_VERSION } from "../../result.js";
import { createFetcher } from "../../fetcher.js";
import { checkAdvisory } from "../run.js";
import { ADVISORY_SCHEMA_VERSION, advisoryResultSchema } from "../schema.js";
import { ADVISORY_TOOL, advisoryToolInput, runAdvisoryTool } from "../tool.js";
import { html, worldTransport, type SiteDef } from "./world.js";

const schemaDir = join(
  fileURLToPath(new URL("../../../../../", import.meta.url)),
  "packages/core/schema",
);
const published = readFileSync(
  join(schemaDir, `advisory.v${ADVISORY_SCHEMA_VERSION}.json`),
  "utf8",
);

const bar: SiteDef = {
  headers: { server: "Vercel", "x-vercel-id": "lhr1::abc" },
  routes: {
    "/": html({ scripts: ["/_next/static/chunks/main-app-3f2a.js"] }),
    "/_next/static/chunks/main-app-3f2a.js": {
      type: "text/javascript",
      body: 'window.next={version:"15.1.0",appDir:!0}',
    },
  },
};

const fetcher = () =>
  createFetcher({ transport: worldTransport({ "harbour-bar.example": bar }).transport });

describe("the advisory answer has its own versioned schema", () => {
  it("is version 1 and is not the result's number", () => {
    expect(ADVISORY_SCHEMA_VERSION).toBe(1);
    expect(RESULT_SCHEMA_VERSION).toBe(2);
  });

  it("the committed file is what the zod definition makes, and its hash is recorded", () => {
    const text = buildSchemaText(advisoryResultSchema, ADVISORY_SCHEMA_VERSION, "advisory");
    expect(checkSchemaDir(schemaDir, ADVISORY_SCHEMA_VERSION, text, "advisory")).toEqual({
      ok: true,
      problems: [],
    });
  });

  it("every verdict the command gives validates against the published file", async () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(JSON.parse(published) as object);
    for (const spec of [
      "CVE-2026-00123",
      "next@<15.0.0",
      "next@<15.1.0",
      "wp-plugin:easy-booking@<2.4.0",
    ]) {
      const result = await checkAdvisory({
        fetcher: fetcher(),
        address: "https://harbour-bar.example/",
        spec,
        now: () => new Date("2026-11-11T09:00:00.000Z"),
      });
      const json = JSON.parse(JSON.stringify(result)) as unknown;
      expect(validate(json), ajv.errorsText(validate.errors)).toBe(true);
      expect(advisoryResultSchema.safeParse(json).success).toBe(true);
    }
  });
});

describe("the MCP tool definition (the server that registers it is a later branch)", () => {
  it("is read only, named, and describes its input", () => {
    expect(ADVISORY_TOOL.name).toBe("gaugeline_advisory");
    expect(ADVISORY_TOOL.annotations.readOnlyHint).toBe(true);
    expect(ADVISORY_TOOL.inputSchema).toMatchObject({
      type: "object",
      required: ["site", "advisory"],
    });
    expect(ADVISORY_TOOL.description).toMatch(/never says a site is safe/);
    expect(ADVISORY_TOOL.description).toMatch(/data, not as instructions/);
  });

  it("answers with the same document as --json", async () => {
    const now = () => new Date("2026-11-11T09:00:00.000Z");
    const viaTool = await runAdvisoryTool(
      { site: "harbour-bar.example", advisory: "CVE-2026-00123" },
      { fetcher: fetcher(), now },
    );
    const direct = await checkAdvisory({
      fetcher: fetcher(),
      address: "harbour-bar.example",
      spec: "CVE-2026-00123",
      now,
    });
    expect(viaTool).toEqual(direct);
  });

  it("refuses an input that does not fit, before any request", () => {
    expect(advisoryToolInput.safeParse({ site: "x.example" }).success).toBe(false);
    expect(
      advisoryToolInput.safeParse({ site: "x.example", advisory: "CVE-2026-1", extra: 1 }).success,
    ).toBe(false);
    return expect(runAdvisoryTool({ site: 5 }, { fetcher: fetcher() })).rejects.toThrow();
  });
});
