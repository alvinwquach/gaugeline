import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildResult, siteEnv } from "@gaugeline/core";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";
import { compareRuns, runAll, type RunOne } from "../run-all.js";
import { readSites, refusal, selectSites, type Site } from "../sites.js";
import { runBin } from "./helpers/bin.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/sites-file/", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The invented sites file in a scratch folder, with the fixture origins put in. */
function workdir(
  origins: Record<string, string> = {},
  edit?: (json: { sites: Record<string, unknown>[] }) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-sites-"));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  let text = readFileSync(join(dir, "gaugeline.sites.json"), "utf8");
  for (const [k, v] of Object.entries(origins)) text = text.replaceAll(`{{${k}}}`, v);
  const json = JSON.parse(text) as { sites: Record<string, unknown>[] };
  edit?.(json);
  writeFileSync(join(dir, "gaugeline.sites.json"), JSON.stringify(json, null, 2));
  return dir;
}

/** A run with no findings for `url`, saved as `runs/<site>/<date>.json`: the previous run. */
function seed(dir: string, site: string, url: string, date = "2026-11-06") {
  const runs = join(dir, "runs", site);
  mkdirSync(runs, { recursive: true });
  writeFileSync(
    join(runs, `${date}.json`),
    JSON.stringify(
      buildResult({
        url,
        startedAt: new Date(`${date}T03:00:00Z`),
        findings: [],
        passed: [],
        failed: [],
      }),
    ),
  );
}

describe("run: unit", () => {
  it("reads the sites file and resolves each config folder", () => {
    const sites = readSites(
      workdir({ clean: "http://127.0.0.1:9", "noindex-header": "http://127.0.0.1:8" }),
    );
    expect(
      sites.map((s) => [
        s.name,
        s.configDir.endsWith("harbour") ? "harbour/" : "(sites file)",
        s.host,
      ]),
    ).toEqual([
      ["harbour", "harbour/", "127.0.0.1:9"],
      ["fern-and-kiln", "(sites file)", "127.0.0.1:8"],
      ["old-shop", "(sites file)", "127.0.0.1:1"],
    ]);
  });

  it("the key prefix maps to the right variables, and preview secrets aren't shared", () => {
    const env = {
      HARBOUR_SANITY_READ_TOKEN: "t-harbour",
      HARBOUR_GAUGELINE_BASIC_AUTH: "u:p",
      FERN_SANITY_READ_TOKEN: "t-fern",
      GAUGELINE_BASIC_AUTH: "shared:secret",
      PATH: "/bin",
    };
    const harbour = siteEnv(env, "HARBOUR");
    expect([harbour.SANITY_READ_TOKEN, harbour.GAUGELINE_BASIC_AUTH, harbour.PATH]).toEqual([
      "t-harbour",
      "u:p",
      "/bin",
    ]);
    const none = siteEnv(env, undefined);
    expect([none.SANITY_READ_TOKEN, none.GAUGELINE_BASIC_AUTH]).toEqual([undefined, undefined]);
  });

  it("a site without permission is refused, with what to add", () => {
    expect(refusal({ name: "acme", address: "acme.example" })).toBe(
      'no permission entry: add "permission": { "by": "<who agreed>", "on": "YYYY-MM-DD" } to "acme" in gaugeline.sites.json',
    );
  });

  it("new, fixed and open against the previous run; the first run has nothing to compare", () => {
    const f = (checkId: string, severity: "high" | "low") => ({
      checkId,
      severity,
      title: "t",
      evidence: "e",
      url: "https://a.example/",
    });
    const run = (findings: ReturnType<typeof f>[]) =>
      buildResult({
        url: "https://a.example/",
        startedAt: new Date("2026-11-07T00:00:00Z"),
        findings,
        passed: [],
        failed: [],
      });
    expect(
      compareRuns(run([f("a", "high"), f("b", "low")]), run([f("a", "high"), f("c", "high")])),
    ).toEqual({ new: 1, newFixFirst: 1, fixed: 1, open: 2, openFixFirst: 2 });
    expect(compareRuns(undefined, run([f("a", "high")]))).toEqual({ open: 1, openFixFirst: 1 });
  });
});

describe("run: integration (three fixture sites, one unreachable)", () => {
  it("two run files written and one couldn't run; the summary lists all three", async () => {
    const clean = await startFixture("clean");
    const noindex = await startFixture("noindex-header");
    try {
      const dir = workdir({ clean: clean.origin, "noindex-header": noindex.origin });
      seed(dir, "fern-and-kiln", `${noindex.origin}/`);
      const out: string[] = [];
      const code = await main(
        ["run", "--all", "--allow-private"],
        {
          stdout: { write: (s: string) => out.push(s) },
          stderr: { write: () => undefined },
          env: { NO_COLOR: "1" },
          now: () => new Date("2026-11-07T03:00:00Z"),
        },
        { cwd: dir },
      );
      expect(readdirSync(join(dir, "runs")).sort()).toEqual(["fern-and-kiln", "harbour"]);
      expect(existsSync(join(dir, "runs", "harbour", "2026-11-07.json"))).toBe(true);
      const lines = out.join("").trimEnd().split("\n");
      expect(lines[0]).toBe("Site             New  Fixed  Fix first");
      expect(lines[1]).toMatch(/^old-shop\s+couldn't run: .*127\.0\.0\.1:1/);
      expect(lines[2]).toBe("fern-and-kiln      1      0          1");
      expect(lines[3]).toBe(
        "harbour            –      –          0  (first run: nothing to compare yet)",
      );
      expect(lines[4]).toBe("3 sites: 1 with a new fix-first finding, 1 couldn't run.");
      expect(code).toBe(1);
    } finally {
      await clean.close();
      await noindex.close();
    }
  });
});

describe("run: e2e (the built command)", () => {
  it("gaugeline run --all prints the summary and exits 1 when one site has a new fix-first finding", async () => {
    const clean = await startFixture("clean");
    const noindex = await startFixture("noindex-header");
    try {
      const dir = workdir({ clean: clean.origin, "noindex-header": noindex.origin });
      seed(dir, "fern-and-kiln", `${noindex.origin}/`);
      const r = await runBin(["run", "--all", "--allow-private"], { NO_COLOR: "1" }, { cwd: dir });
      expect(r.stdout.trimEnd()).toBe(
        expectedOutput("guides/many-sites", "Three sites, one unreachable"),
      );
      expect(r.stdout).toContain("fern-and-kiln      1      0          1");
      expect(r.stdout).toContain("3 sites: 1 with a new fix-first finding, 1 couldn't run.");
      expect(r.status).toBe(1);
    } finally {
      await clean.close();
      await noindex.close();
    }
  });
});

describe("run: edge cases", () => {
  it("two sites with the same name stop before any check", () => {
    const dir = workdir({}, (j) => {
      if (j.sites[1]) j.sites[1].name = "harbour";
    });
    expect(() => readSites(dir)).toThrow('two sites are named "harbour"');
  });

  it("--parallel 3 never runs two sites of one host at once", async () => {
    const site = (name: string, host: string): Site => ({
      name,
      address: `http://${host}/`,
      host,
      configDir: "/",
      permission: { by: "me", on: "2026-11-01" },
    });
    const sites = [
      site("a1", "a.test"),
      site("a2", "a.test"),
      site("b", "b.test"),
      site("a3", "a.test"),
      site("c", "c.test"),
    ];
    const inFlight = new Map<string, number>();
    let overlap = 0;
    let most = 0;
    let running = 0;
    const runOne: RunOne = async (argv, io) => {
      const host = new URL(argv[0] ?? "").host;
      inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
      running++;
      most = Math.max(most, running);
      if ((inFlight.get(host) ?? 0) > 1) overlap++;
      await new Promise((r) => setTimeout(r, 15));
      inFlight.set(host, (inFlight.get(host) ?? 1) - 1);
      running--;
      io.stdout.write(
        JSON.stringify(
          buildResult({
            url: argv[0] ?? "",
            startedAt: new Date(),
            findings: [],
            passed: [],
            failed: [],
          }),
        ),
      );
      return 0;
    };
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-par-"));
    dirs.push(dir);
    const rows = await runAll(sites, { runsDir: dir, env: {}, parallel: 3, runOne });
    expect(rows.map((r) => r.site)).toEqual(["a1", "a2", "b", "a3", "c"]);
    expect(rows.every((r) => r.couldNotRun === undefined)).toBe(true);
    expect(overlap).toBe(0);
    expect(most).toBe(3);
  });

  it("a tag that matches nothing: says so, checks nothing, exits 0", async () => {
    const dir = workdir();
    expect(selectSites(readSites(dir), { tag: "nobody" })).toEqual([]);
    const err: string[] = [];
    const code = await main(
      ["run", "--tag", "nobody"],
      {
        stdout: { write: () => undefined },
        stderr: { write: (s: string) => err.push(s) },
        env: {},
      },
      { cwd: dir },
    );
    expect([code, err.join("")]).toEqual([
      0,
      'No site in gaugeline.sites.json has the tag "nobody": nothing to check.\n',
    ]);
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });

  it("a site without permission is refused in the summary; the others still run", async () => {
    const clean = await startFixture("clean");
    try {
      const dir = workdir({ clean: clean.origin, "noindex-header": "http://127.0.0.1:1/" }, (j) => {
        delete j.sites[1]?.permission;
      });
      const out: string[] = [];
      await main(
        ["run", "--all", "--allow-private"],
        {
          stdout: { write: (s: string) => out.push(s) },
          stderr: { write: () => undefined },
          env: {},
        },
        { cwd: dir },
      );
      expect(out.join("")).toContain(
        'fern-and-kiln  couldn\'t run: no permission entry: add "permission"',
      );
      expect(existsSync(join(dir, "runs", "harbour"))).toBe(true);
    } finally {
      await clean.close();
    }
  });
});

describe("run: the nightly workflow example", () => {
  const text = readFileSync(
    fileURLToPath(new URL("../../../../examples/workflows/nightly-all-sites.yml", import.meta.url)),
    "utf8",
  );
  it("parses: nightly, commits the runs back, builds the digests, keys only from secrets by prefix", async () => {
    const { parse } = await import("yaml");
    const wf = parse(text) as {
      on: { schedule: { cron: string }[] };
      permissions: Record<string, string>;
      jobs: Record<string, { steps: { run?: string; env?: Record<string, string> }[] }>;
    };
    expect(wf.on.schedule[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(wf.permissions.contents).toBe("write");
    const steps = Object.values(wf.jobs)[0]?.steps ?? [];
    const runs = steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("gaugeline run --all");
    expect(runs).toContain("gaugeline digest --runs .");
    expect(runs).toMatch(/git add runs[\s\S]*git push/);
    for (const step of steps)
      for (const [name, value] of Object.entries(step.env ?? {})) {
        expect(name).toMatch(/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/);
        expect(value).toBe(`\${{ secrets.${name} }}`);
      }
  });
});
