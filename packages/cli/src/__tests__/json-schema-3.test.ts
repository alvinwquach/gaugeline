import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CheckRegistry,
  defineCheck,
  parseResult,
  parseResultV3,
  type Finding,
  type PageSnapshot,
} from "@gaugeline/core";
import { parseCliArgs } from "../args.js";
import { main } from "../main.js";
import {
  html,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";
import { runBin } from "./helpers/bin.js";

/**
 * `--json --json-schema 3`: the result with what suppressions and the baseline hide. Schema 2 stays the
 * default and never gains a field. Small rules defined here, so the findings are known in advance.
 */

const schemaFile = fileURLToPath(new URL("../../../core/schema/result.v3.json", import.meta.url));
const NOW = new Date("2026-11-12T10:00:00Z");

let site: FixtureServer;
beforeAll(async () => {
  site = await startServer({
    "/": html(
      "<html><head><title>Fernhill Taproom</title></head><body><h1>Pints</h1></body></html>",
    ),
  });
});
afterAll(async () => {
  await site.close();
});
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-schema3-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function rule(id: string, severity: Finding["severity"]) {
  return defineCheck<PageSnapshot>({
    id,
    area: "Visitors",
    severity,
    title: `Problem ${id}`,
    what: "w",
    why: "y",
    fix: "f",
    tech: "t",
    size: "S",
    done: "d",
    estimateChanges: "e",
    run: (page) => [
      {
        checkId: id,
        severity,
        title: `Problem ${id}`,
        evidence: `evidence of ${id}`,
        url: page.finalUrl,
      },
    ],
  });
}
function registryOf(...ids: [string, Finding["severity"]][]): CheckRegistry {
  const r = new CheckRegistry();
  for (const [id, severity] of ids) r.register(rule(id, severity));
  return r;
}

async function run(args: string[], cwd: string, registry: CheckRegistry) {
  let out = "";
  let err = "";
  const io = {
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    env: {},
  };
  const code = await main([site.origin, "--allow-private", "--no-open", ...args], io, {
    registry,
    cwd,
    now: () => NOW,
  });
  return { code, out, err };
}

const validate = (() => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(schemaFile, "utf8")) as object);
})();

const config = (until: string, extra: object[] = []) =>
  JSON.stringify({
    suppress: [{ id: "menu-missing", until, reason: "the menu page is being rewritten" }, ...extra],
  });

describe("--json-schema: arguments", () => {
  it("3 is read; 2 and no flag leave the result at schema 2", () => {
    expect(parseCliArgs(["example.com", "--json", "--json-schema", "3"])).toMatchObject({
      kind: "run",
      jsonSchema: 3,
    });
    for (const argv of [
      ["example.com", "--json"],
      ["example.com", "--json", "--json-schema", "2"],
    ])
      expect(parseCliArgs(argv)).not.toHaveProperty("jsonSchema");
    expect(parseCliArgs(["example.com", "--format", "json", "--json-schema=3"])).toMatchObject({
      jsonSchema: 3,
    });
  });

  it("an unknown number is refused and says what is accepted", () => {
    for (const bad of ["4", "0", "x", "3.5", "-3", "03", "3.0", "+3"])
      expect(parseCliArgs(["example.com", "--json", `--json-schema=${bad}`]), bad).toMatchObject({
        kind: "error",
        message: expect.stringContaining("--json-schema accepts 2 or 3"),
      });
  });

  it("schema 1 is refused with its own sentence, naming the published file", () => {
    expect(parseCliArgs(["example.com", "--json", "--json-schema", "1"])).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/schema 1 is no longer printed.*result\.v1\.json.*2.*3/),
    });
  });

  it("it needs --json: alone and with another format it is a usage error", () => {
    for (const argv of [
      ["example.com", "--json-schema", "3"],
      ["example.com", "--format", "sarif", "--json-schema", "3"],
    ])
      expect(parseCliArgs(argv), argv.join(" ")).toMatchObject({
        kind: "error",
        message: expect.stringContaining("needs --json"),
      });
  });

  it("a command that cannot print the result says so in one sentence", () => {
    expect(parseCliArgs(["digest", "--json-schema", "3"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--json-schema only works with the page check"),
    });
  });
});

describe("--json-schema 3: integration", () => {
  it("lists a suppressed finding with the entry that hid it, and the result validates", async () => {
    const dir = folder({ "gaugeline.config.json": config("2026-12-01") });
    const r = await run(
      ["--json", "--json-schema", "3"],
      dir,
      registryOf(["menu-missing", "high"], ["hours-missing", "medium"]),
    );
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out) as Record<string, unknown>;
    expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
    const v3 = parseResultV3(json);
    expect(v3.schema).toBe(3);
    expect(v3.findings.map((f) => f.checkId)).toEqual(["hours-missing"]);
    expect(v3.suppressed).toHaveLength(1);
    expect(v3.suppressed[0]).toEqual({
      finding: expect.objectContaining({ checkId: "menu-missing", severity: "high" }),
      by: {
        id: "menu-missing",
        until: "2026-12-01",
        reason: "the menu page is being rewritten",
      },
    });
    expect(v3.expiredSuppressions).toEqual([]);
    expect(v3.baselined).toEqual([]);
  });

  it("with no suppressions and no baseline all four lists are empty and present", async () => {
    const r = await run(
      ["--json", "--json-schema", "3"],
      folder(),
      registryOf(["menu-missing", "high"]),
    );
    const v3 = parseResultV3(JSON.parse(r.out));
    expect(v3.findings).toHaveLength(1);
    expect([v3.suppressed, v3.expiredSuppressions, v3.unmatchedSuppressions, v3.baselined]).toEqual(
      [[], [], [], []],
    );
  });

  it("an expired entry is listed as expired, and its finding is back in findings", async () => {
    const dir = folder({ "gaugeline.config.json": config("2026-11-11") });
    const r = await run(
      ["--json", "--json-schema", "3"],
      dir,
      registryOf(["menu-missing", "high"]),
    );
    const v3 = parseResultV3(JSON.parse(r.out));
    expect(v3.findings.map((f) => f.checkId)).toEqual(["menu-missing"]);
    expect(v3.suppressed).toEqual([]);
    expect(v3.expiredSuppressions).toEqual([
      { id: "menu-missing", until: "2026-11-11", reason: "the menu page is being rewritten" },
    ]);
  });

  it("an entry that matched nothing is listed as unmatched", async () => {
    const dir = folder({
      "gaugeline.config.json": config("2026-12-01", [
        { id: "mistyped-id", until: "2026-12-01", reason: "oops" },
      ]),
    });
    const r = await run(
      ["--json", "--json-schema", "3"],
      dir,
      registryOf(["menu-missing", "high"]),
    );
    const v3 = parseResultV3(JSON.parse(r.out));
    expect(v3.unmatchedSuppressions.map((e) => e.id)).toEqual(["mistyped-id"]);
  });

  it("baselined findings are listed in baselined, and a --suppress flag counts like the config", async () => {
    const dir = folder();
    const reg = () => registryOf(["menu-missing", "high"], ["hours-missing", "medium"]);
    await run(["--baseline", "base.json"], dir, registryOf(["menu-missing", "high"]));
    const r = await run(
      [
        "--json",
        "--json-schema",
        "3",
        "--baseline",
        "base.json",
        "--suppress",
        "hours-missing",
        "--suppress-until",
        "2026-12-31",
        "--suppress-reason",
        "away",
      ],
      dir,
      reg(),
    );
    const v3 = parseResultV3(JSON.parse(r.out));
    expect(v3.findings).toEqual([]);
    expect(v3.baselined.map((f) => f.checkId)).toEqual(["menu-missing"]);
    expect(v3.suppressed.map((s) => s.by.reason)).toEqual(["away"]);
  });

  it("schema 3 changes nothing but the JSON: the exit code and stderr are the same as schema 2", async () => {
    const dir = folder({ "gaugeline.config.json": config("2026-12-01") });
    const reg = () => registryOf(["menu-missing", "high"], ["hours-missing", "high"]);
    const two = await run(["--json", "--ci"], dir, reg());
    const three = await run(["--json", "--json-schema", "3", "--ci"], dir, reg());
    expect(three.code).toBe(two.code);
    expect(three.code).toBe(1);
    expect(three.err).toBe(two.err);
  });
});

describe("schemas 1 and 2: the consumer-facing guarantee", () => {
  it("the default --json is schema 2 with its eight keys, with a suppression active, expired or absent", async () => {
    const eight = [
      "couldNotCheck",
      "failed",
      "findings",
      "passed",
      "sampled",
      "schema",
      "startedAt",
      "url",
    ];
    for (const until of ["2026-12-01", "2026-11-11"]) {
      const dir = folder({ "gaugeline.config.json": config(until) });
      const r = await run(["--json"], dir, registryOf(["menu-missing", "high"]));
      const json = JSON.parse(r.out) as Record<string, unknown>;
      expect(Object.keys(json).sort()).toEqual(eight);
      expect(parseResult(json).schema).toBe(2);
    }
    const bare = await run(["--json"], folder(), registryOf(["menu-missing", "high"]));
    expect(Object.keys(JSON.parse(bare.out) as object).sort()).toEqual(eight);
  });

  it("--json-schema 2 prints the same bytes as no flag", async () => {
    const dir = folder({ "gaugeline.config.json": config("2026-12-01") });
    const reg = () => registryOf(["menu-missing", "high"], ["hours-missing", "low"]);
    const plain = await run(["--json"], dir, reg());
    const two = await run(["--json", "--json-schema", "2"], dir, reg());
    // startedAt is the run's own start time: the one field that differs between two runs.
    const same = (text: string) => text.replace(/"startedAt": "[^"]+"/, '"startedAt": "-"');
    expect(same(two.out)).toBe(same(plain.out));
    expect(two.err).toBe(plain.err);
  });
});

describe("--json-schema 3: end to end on the built command", () => {
  it("prints schema 3 on stdout for a real run, and refuses 4 and 1 with exit 2 and no stdout", async () => {
    const dir = folder({
      "gaugeline.config.json": JSON.stringify({
        suppress: [
          { id: "og-image-missing", until: "2099-01-01", reason: "Photo shoot is Friday" },
        ],
      }),
    });
    const ok = await runBin([site.origin + "/", "--json", "--json-schema", "3"], {}, { cwd: dir });
    expect([0, 1]).toContain(ok.status);
    const v3 = parseResultV3(JSON.parse(ok.stdout));
    expect(validate(JSON.parse(ok.stdout)), JSON.stringify(validate.errors)).toBe(true);
    expect(v3.schema).toBe(3);
    expect(v3.suppressed.map((s) => s.by.id)).toEqual(["og-image-missing"]);

    const four = await runBin(
      [site.origin + "/", "--json", "--json-schema", "4"],
      {},
      { cwd: dir },
    );
    expect(four.status).toBe(2);
    expect(four.stdout).toBe("");
    expect(four.stderr).toContain("--json-schema accepts 2 or 3");
    const one = await runBin([site.origin + "/", "--json", "--json-schema", "1"], {}, { cwd: dir });
    expect(one.status).toBe(2);
    expect(one.stderr).toContain("result.v1.json");
  }, 30_000);

  it("the same run without the flag still prints schema 2", async () => {
    const dir = folder();
    const r = await runBin([site.origin + "/", "--json"], {}, { cwd: dir });
    expect(parseResult(JSON.parse(r.stdout)).schema).toBe(2);
    expect(r.stdout).not.toContain("suppressed");
  }, 30_000);
});
