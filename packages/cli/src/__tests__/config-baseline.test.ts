import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CheckRegistry, defineCheck, type Finding, type PageSnapshot } from "@gaugeline/core";
import { main } from "../main.js";
import {
  html,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";

/**
 * gaugeline.config, --baseline and expiring suppressions, through main() on an invented bar's
 * site: the checks are small rules defined here, so the findings are known in advance.
 */

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
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-config-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** A rule that reports what `plant` says it should, with a number in the evidence that changes each run. */
function rule(id: string, severity: Finding["severity"], plant: { on: boolean } = { on: true }) {
  let run = 0;
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
    run: (page) => {
      run += 1;
      return plant.on
        ? [
            {
              checkId: id,
              severity,
              title: `Problem ${id}`,
              evidence: `${10 + run} items took ${run * 7} ms`,
              url: page.finalUrl,
            },
          ]
        : [];
    },
  });
}

function registryOf(...checks: ReturnType<typeof rule>[]): CheckRegistry {
  const r = new CheckRegistry();
  for (const c of checks) r.register(c);
  return r;
}

async function run(
  args: string[],
  cwd: string,
  registry: CheckRegistry,
  now = new Date("2026-11-12T10:00:00Z"),
  env: Record<string, string> = {},
) {
  let out = "";
  let err = "";
  const io = {
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    env,
  };
  const code = await main([site.origin, "--allow-private", "--no-open", ...args], io, {
    registry,
    cwd,
    now: () => now,
  });
  return { code, out, err };
}

describe("--baseline: integration", () => {
  it("run twice: the second reports zero new; add one planted problem: exactly one new", async () => {
    const dir = folder();
    const plant = { on: true };
    const first = await run(
      ["--ci", "--baseline", "base.json", "--update-baseline"],
      dir,
      registryOf(rule("menu-missing", "high")),
    );
    expect(first.err).toContain("Baseline written to base.json: 1 finding now known");
    expect(first.code).toBe(0);

    const second = await run(
      ["--ci", "--baseline", "base.json"],
      dir,
      registryOf(rule("menu-missing", "high", plant)),
    );
    expect(second.err).toContain(
      "1 known finding in base.json left out (1 Fix this first); 0 new.",
    );
    expect(second.out).not.toContain("Problem menu-missing");
    expect(second.code).toBe(0);

    const third = await run(
      ["--ci", "--baseline", "base.json"],
      dir,
      registryOf(rule("menu-missing", "high"), rule("hours-missing", "high")),
    );
    expect(third.err).toContain("1 known finding in base.json left out (1 Fix this first); 1 new.");
    expect(third.out).toContain("Problem hours-missing");
    expect(third.out).not.toContain("Problem menu-missing");
    expect(third.code).toBe(1);
  });

  it("the file holds fingerprints, check ids and paths, no evidence", async () => {
    const dir = folder();
    await run(["--baseline", "base.json"], dir, registryOf(rule("menu-missing", "high")));
    const text = readFileSync(join(dir, "base.json"), "utf8");
    expect(JSON.parse(text).schema).toBe(1);
    expect(text).toContain('"checkId": "menu-missing"');
    expect(text).not.toContain("items took");
    expect(text).not.toContain("127.0.0.1");
  });

  it("--update-baseline accepts what is found now", async () => {
    const dir = folder();
    await run(["--baseline", "base.json"], dir, registryOf(rule("a-rule", "high")));
    const r = await run(
      ["--ci", "--baseline", "base.json", "--update-baseline"],
      dir,
      registryOf(rule("a-rule", "high"), rule("b-rule", "high")),
    );
    expect(r.err).toContain("Baseline written to base.json: 2 findings");
    expect(r.code).toBe(0);
  });

  it("a malformed or newer baseline is exit 2 with a plain message, never a silent pass", async () => {
    const dir = folder({ "bad.json": "{not json", "new.json": '{"schema":2,"findings":[]}' });
    const bad = await run(
      ["--ci", "--baseline", "bad.json"],
      dir,
      registryOf(rule("a-rule", "high")),
    );
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("bad.json is not valid JSON");
    const newer = await run(
      ["--ci", "--baseline", "new.json"],
      dir,
      registryOf(rule("a-rule", "high")),
    );
    expect(newer.code).toBe(2);
    expect(newer.err).toContain("schema 2");
  });
});

describe("suppressions that expire: integration", () => {
  const config = (until: string) =>
    JSON.stringify({
      suppress: [{ id: "menu-missing", until, reason: "the menu page is being rewritten" }],
    });

  it("an active suppression hides the finding and does not fail", async () => {
    const dir = folder({ "gaugeline.config.json": config("2026-12-01") });
    const r = await run(["--ci"], dir, registryOf(rule("menu-missing", "high")));
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Problem menu-missing");
    expect(r.err).toContain(
      "1 finding snoozed by a suppression (1 Fix this first): menu-missing until 2026-12-01",
    );
  });

  it("an expired one stops applying, is reported, and the finding fails again", async () => {
    const dir = folder({ "gaugeline.config.json": config("2026-11-11") });
    const r = await run(["--ci"], dir, registryOf(rule("menu-missing", "high")));
    expect(r.err).toContain("Suppression of menu-missing expired on 2026-11-11");
    expect(r.err).toContain("the finding is back");
    expect(r.out).toContain("Problem menu-missing");
    expect(r.code).toBe(1);
  });

  it("an expired one is still reported, with --quiet, when the finding is gone", async () => {
    const dir = folder({ "gaugeline.config.json": config("2026-11-11") });
    const r = await run(
      ["--ci", "--quiet"],
      dir,
      registryOf(rule("menu-missing", "high", { on: false })),
    );
    expect(r.err).toContain("expired on 2026-11-11");
    expect(r.code).toBe(0);
  });

  it("--suppress needs a reason and a date, and a past date is refused", async () => {
    const dir = folder();
    const reg = () => registryOf(rule("menu-missing", "high"));
    const noReason = await run(
      ["--suppress", "menu-missing", "--suppress-until", "2026-12-01"],
      dir,
      reg(),
    );
    expect(noReason.code).toBe(2);
    expect(noReason.err).toContain("--suppress-reason");
    const noDate = await run(
      ["--suppress", "menu-missing", "--suppress-reason", "away"],
      dir,
      reg(),
    );
    expect(noDate.code).toBe(2);
    expect(noDate.err).toContain("--suppress-until");
    const past = await run(
      ["--suppress", "menu-missing", "--suppress-until", "2026-11-01", "--suppress-reason", "away"],
      dir,
      reg(),
    );
    expect(past.code).toBe(2);
    expect(past.err).toContain("already past");
    const ok = await run(
      [
        "--ci",
        "--suppress",
        "menu-missing",
        "--suppress-until",
        "2026-11-12",
        "--suppress-reason",
        "away",
      ],
      dir,
      reg(),
    );
    expect(ok.code).toBe(0);
  });
});

describe("gaugeline.config: integration", () => {
  it("block fails --ci at any severity, warn never, off does not run the check", async () => {
    const reg = () =>
      registryOf(rule("low-rule", "low"), rule("high-rule", "high"), rule("skip-rule", "high"));
    const plain = await run(["--ci"], folder(), reg());
    expect(plain.code).toBe(1);
    const dir = folder({
      "gaugeline.config.json": JSON.stringify({
        checks: { "low-rule": "block", "high-rule": "warn", "skip-rule": "off" },
      }),
    });
    const r = await run(["--ci"], dir, reg());
    expect(r.code).toBe(1);
    expect(r.out).toContain("Problem low-rule");
    expect(r.out).toContain("Problem high-rule");
    expect(r.out).not.toContain("Problem skip-rule");
    expect(r.err).toContain("1 check turned off in gaugeline.config.json: skip-rule");
    const warnOnly = folder({
      "gaugeline.config.json": JSON.stringify({ checks: { "high-rule": "warn" } }),
    });
    expect((await run(["--ci"], warnOnly, registryOf(rule("high-rule", "high")))).code).toBe(0);
  });

  it("an invalid file is exit 2 and names the key; a key that would loosen a guard is refused", async () => {
    const bad = await run(
      ["--ci"],
      folder({ "gaugeline.config.json": '{"suppress":[{"id":"a","reason":"r"}]}' }),
      registryOf(rule("a", "high")),
    );
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("suppress.0.until");
    for (const key of ["allowPrivate", "ownerConsent"]) {
      const r = await run(
        [],
        folder({ "gaugeline.config.json": JSON.stringify({ [key]: true }) }),
        registryOf(rule("a", "high")),
      );
      expect(r.code).toBe(2);
      expect(r.err).toContain(key);
    }
  });

  it("two config files are an error, not a silent choice", async () => {
    const r = await run(
      [],
      folder({ "gaugeline.config.json": "{}", "gaugeline.config.mjs": "export default {}" }),
      registryOf(rule("a", "high")),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("More than one config file");
  });

  it("the config is read from the working folder only: the site's own config is never asked for", async () => {
    site.log.length = 0;
    await run(["--ci"], folder(), registryOf(rule("a", "low")));
    expect(site.log.map((q) => q.path).filter((p) => p.includes("gaugeline.config"))).toEqual([]);
  });

  const custom = (id: string, body: string) =>
    `export default { custom: [{ id: "${id}", area: "Visitors", severity: "high", title: "Opening hours missing", what: "w", why: "y", fix: "f", tech: "t", size: "S", done: "d", estimateChanges: "e", run(page) { ${body} } }] };`;

  it("a custom check in an .mjs config runs; one that throws is isolated like a built-in", async () => {
    const found = folder({
      "gaugeline.config.mjs": custom(
        "hours-missing",
        `return [{ checkId: "hours-missing", severity: "high", title: "Opening hours missing", evidence: "no hours", url: page.finalUrl }];`,
      ),
    });
    const r = await run(["--ci"], found, registryOf(rule("a-rule", "low", { on: false })));
    expect(r.out).toContain("Opening hours missing");
    expect(r.code).toBe(1);

    const throwing = folder({
      "gaugeline.config.mjs": custom("boom-rule", `throw new Error("bad");`),
    });
    const t = await run(["--ci"], throwing, registryOf(rule("a-rule", "low")));
    expect(t.out).toContain("1 check could not run: boom-rule");
    expect(t.out).toContain("Problem a-rule");
    expect(t.code).toBe(0);
  });

  it("a custom id that collides with a built-in is exit 2", async () => {
    const dir = folder({ "gaugeline.config.mjs": custom("menu-missing", "return [];") });
    const r = await run([], dir, registryOf(rule("menu-missing", "high")));
    expect(r.code).toBe(2);
    expect(r.err).toContain("custom.0.id");
    expect(r.err).toContain("already a built-in check");
  });

  it("a JSON config cannot hold a custom check", async () => {
    const dir = folder({ "gaugeline.config.json": '{"custom":[{"id":"x"}]}' });
    const r = await run([], dir, registryOf(rule("a", "high")));
    expect(r.code).toBe(2);
    expect(r.err).toContain("custom.0");
  });
});

describe("review fixes: baseline in CI, unmatched suppressions, executable config, custom context", () => {
  it("under --ci a missing baseline is exit 2 and writes nothing; --update-baseline writes it", async () => {
    const dir = folder();
    const reg = () => registryOf(rule("menu-missing", "high"));
    const r = await run(["--ci", "--baseline", "base.json"], dir, reg());
    expect(r.code).toBe(2);
    expect(r.err).toContain("base.json does not exist");
    expect(existsSync(join(dir, "base.json"))).toBe(false);
    const w = await run(["--ci", "--baseline", "base.json", "--update-baseline"], dir, reg());
    expect(w.code).toBe(0);
    expect(existsSync(join(dir, "base.json"))).toBe(true);
  });

  it("a baseline that is wrong is refused before the first request", async () => {
    site.log.length = 0;
    const dir = folder({ "bad.json": "{nope" });
    const r = await run(["--baseline", "bad.json"], dir, registryOf(rule("a-rule", "high")));
    expect(r.code).toBe(2);
    expect(site.log).toEqual([]);
  });

  it("a past --suppress-until is refused before the first request", async () => {
    site.log.length = 0;
    const r = await run(
      ["--suppress", "a-rule", "--suppress-until", "2026-11-01", "--suppress-reason", "away"],
      folder(),
      registryOf(rule("a-rule", "high")),
    );
    expect(r.code).toBe(2);
    expect(site.log).toEqual([]);
  });

  it("a suppression that matches nothing is named on stderr, even with --quiet", async () => {
    const dir = folder({
      "gaugeline.config.json": JSON.stringify({
        suppress: [
          { id: "menu-mising", until: "2026-12-01", reason: "typo" },
          {
            id: "menu-missing",
            url: "fernhill.example/menu",
            until: "2026-12-01",
            reason: "no scheme",
          },
        ],
      }),
    });
    const r = await run(["--quiet"], dir, registryOf(rule("menu-missing", "high")));
    expect(r.err).toContain("Suppression of menu-mising (until 2026-12-01) matched no finding");
    expect(r.err).toContain("no check has that id");
    expect(r.err).toContain("Suppression of menu-missing on fernhill.example/menu");
  });

  it("snoozed findings are counted under --quiet, with how many were Fix this first", async () => {
    const dir = folder({
      "gaugeline.config.json": JSON.stringify({
        suppress: [{ id: "menu-missing", until: "2026-12-01", reason: "rewrite" }],
      }),
    });
    const r = await run(["--ci", "--quiet"], dir, registryOf(rule("menu-missing", "high")));
    expect(r.code).toBe(0);
    expect(r.err).toContain("1 finding snoozed by a suppression (1 Fix this first)");
  });

  it("an unknown id under block is exit 2; under warn it is a notice even with --quiet", async () => {
    const blocked = await run(
      ["--ci"],
      folder({ "gaugeline.config.json": JSON.stringify({ checks: { "mailto-ctaa": "block" } }) }),
      registryOf(rule("menu-missing", "low")),
    );
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain("checks.mailto-ctaa");
    const warned = await run(
      ["--quiet"],
      folder({ "gaugeline.config.json": JSON.stringify({ checks: { "mailto-ctaa": "warn" } }) }),
      registryOf(rule("menu-missing", "low")),
    );
    expect(warned.code).toBe(0);
    expect(warned.err).toContain("checks.mailto-ctaa: no check has that id");
  });

  const program = `export default { custom: [{ id: "probe-rule", area: "Visitors", severity: "low", title: "Probe", what: "w", why: "y", fix: "f", tech: "t", size: "S", done: "d", estimateChanges: "e", run(page, ctx) { return [{ checkId: "probe-rule", severity: "low", title: "Probe", evidence: "keys:" + Object.keys(ctx).sort().join(",") + " fetcher:" + Object.keys(ctx.fetcher ?? {}).join(","), url: page.finalUrl }]; } }] };`;

  it("a config that runs code says so on stderr every time", async () => {
    const r = await run(
      [],
      folder({ "gaugeline.config.mjs": program }),
      registryOf(rule("a", "low", { on: false })),
    );
    expect(r.err).toContain("Running code from gaugeline.config.mjs");
  });

  it("--config-json-only and GAUGELINE_NO_EXEC_CONFIG refuse it, before the first request", async () => {
    site.log.length = 0;
    const dir = folder({ "gaugeline.config.mjs": program });
    const flag = await run(["--config-json-only"], dir, registryOf(rule("a", "low")));
    expect(flag.code).toBe(2);
    expect(flag.err).toContain("accepts a JSON config only");
    const env = await run([], dir, registryOf(rule("a", "low")), undefined, {
      GAUGELINE_NO_EXEC_CONFIG: "1",
    });
    expect(env.code).toBe(2);
    expect(site.log).toEqual([]);
    const json = folder({ "gaugeline.config.json": "{}" });
    expect((await run(["--config-json-only"], json, registryOf(rule("a", "low")))).code).toBe(0);
  });

  it("the baseline counts and the written line are printed under --quiet, with how many known were Fix this first", async () => {
    const dir = folder();
    const w = await run(
      ["--quiet", "--baseline", "b.json"],
      dir,
      registryOf(rule("menu-missing", "high")),
    );
    expect(w.err).toContain("Baseline written to b.json: 1 finding now known");
    const r = await run(
      ["--quiet", "--baseline", "b.json"],
      dir,
      registryOf(rule("menu-missing", "high"), rule("hours-missing", "high")),
    );
    expect(r.err).toContain("1 known finding in b.json left out (1 Fix this first); 1 new.");
  });

  it("a program config that throws at import has already been announced", async () => {
    const dir = folder({ "gaugeline.config.mjs": 'throw new Error("boom at import");' });
    const r = await run([], dir, registryOf(rule("a", "low")));
    expect(r.code).toBe(2);
    expect(r.err.indexOf("Running code from gaugeline.config.mjs")).toBeGreaterThanOrEqual(0);
    expect(r.err.indexOf("Running code from")).toBeLessThan(r.err.indexOf("boom at import"));
  });

  const prober = `export default { custom: [{ id: "env-prober", area: "Security & email", severity: "low", title: "Probe", what: "w", why: "y", fix: "f", tech: "t", size: "S", done: "d", estimateChanges: "e", async run(page, ctx) { await ctx.fetcher.get(new URL("/.env", page.finalUrl).href); return []; } }] };`;

  it("a custom check cannot ask for /.env without --owner-consent; with it, one GET goes out", async () => {
    site.log.length = 0;
    const dir = folder({ "gaugeline.config.mjs": prober });
    const no = await run([], dir, registryOf(rule("a", "low", { on: false })));
    expect(no.out).toContain("1 check could not run: env-prober");
    expect(site.log.map((q) => q.path)).not.toContain("/.env");
    const yes = await run(
      ["--owner-consent"],
      dir,
      registryOf(rule("a", "low", { on: false })),
      undefined,
      {},
    );
    expect(yes.out).not.toContain("could not run: env-prober");
    expect(site.log.filter((q) => q.path === "/.env").map((q) => q.method)).toEqual(["GET"]);
  });

  it("a custom check sees get but no query, and no consent value, even with --owner-consent", async () => {
    const r = await run(
      ["--owner-consent"],
      folder({ "gaugeline.config.mjs": program }),
      registryOf(rule("a", "low", { on: false })),
    );
    expect(r.out).toContain("keys:couldNotCheck,fetcher,now,warn fetcher:get");
  });

  it("a custom id that a flag-only built-in uses is refused although this run does not have it", async () => {
    const dir = folder({
      "gaugeline.config.mjs": program.replaceAll("probe-rule", "wp-users-exposed"),
    });
    const r = await run([], dir, registryOf(rule("a", "low")));
    expect(r.code).toBe(2);
    expect(r.err).toContain("custom.0.id");
  });
});
