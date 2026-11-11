import { COPPERHILL_COUNTS, sanityCountsTransport } from "@gaugeline/testkit";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, main } from "../main.js";

const ENV = { SANITY_PROJECT_ID: "cprhl1b4", SANITY_DATASET: "production" };
const NOW = new Date("2026-11-10T12:00:00Z");
const HEADER =
  "Content system: Sanity, with a read-only key. Endpoints and how to make the key: https://gaugeline.dev/docs/private-datasets";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-adapters-")));
  writeFileSync(
    join(dir, "page.ts"),
    'import { groq } from "next-sanity";\nexport const q = groq`*[_type == "popup" && defined(slug.current)]{ title, date }`;\n',
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function query(env: Record<string, string | undefined> = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["query", "."],
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env,
    },
    {
      cwd: dir,
      now: () => NOW,
      fetcher: { transport: sanityCountsTransport(COPPERHILL_COUNTS, []), timeoutMs: 5000 },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline query: the content system line (the run header): e2e", () => {
  it("names Sanity and the kind of key before it says what it asked", async () => {
    const r = await query();
    expect(r.code).toBe(EXIT.ok);
    const at = r.out.indexOf(HEADER);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(r.out.indexOf("Counted the published documents"));
  });

  it("is not printed when no dataset is asked: no project id, no content system", async () => {
    const r = await query({});
    expect(r.out).not.toContain("Content system:");
  });

  it("never carries a token", async () => {
    const token = ["sk", "viewer", "Adapters0123456789abcdef"].join("_");
    const r = await query({ ...ENV, SANITY_TOKEN: token });
    expect(r.out + r.err).not.toContain(token);
    expect(r.out).toContain(HEADER);
  });
});

describe("gaugeline.adapters.json in gaugeline query: e2e", () => {
  it("a file that names sanity is read and changes nothing", async () => {
    const before = await query();
    writeFileSync(join(dir, "gaugeline.adapters.json"), '{ "adapters": [{ "id": "sanity" }] }');
    const after = await query();
    expect(after.code).toBe(EXIT.ok);
    expect(after.out).toBe(before.out);
  });

  it("an adapter that is planned is exit 2 and names the branch that builds it", async () => {
    writeFileSync(join(dir, "gaugeline.adapters.json"), '{ "adapters": [{ "id": "webflow" }] }');
    const r = await query();
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain('the "webflow" adapter is planned (C-04)');
    expect(r.err).toContain("Built adapters: sanity, wordpress");
    expect(r.out).toBe("");
  });

  it("an adapter nobody has heard of, a bad shape or bad JSON is exit 2 with the file named", async () => {
    for (const body of [
      '{ "adapters": [{ "id": "nope" }] }',
      '{ "adapters": [{ "id": "sanity", "token": "x" }] }',
      "{ not json",
    ]) {
      writeFileSync(join(dir, "gaugeline.adapters.json"), body);
      const r = await query();
      expect(r.code, body).toBe(EXIT.couldNotRun);
      expect(r.err, body).toContain("gaugeline.adapters.json");
    }
  });
});
