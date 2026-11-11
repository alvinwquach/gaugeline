import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultSchema } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  BAR_CONFIG,
  CHARGES_URL_TEAM,
  ENV,
  JUMPED,
  NOW,
  POPUP,
  VERCEL_TOKEN,
  world,
} from "../../../core/src/cost/__tests__/world.js";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";
import { runAll } from "../run-all.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function folder(config?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-cost-")));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, "gaugeline.cost.json"), config);
  return dir;
}

const BAR = JSON.stringify(BAR_CONFIG);

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined> = ENV,
  over: Parameters<typeof world>[0] = {
    charges: { [CHARGES_URL_TEAM]: { status: 200, body: JUMPED } },
  },
) {
  const w = world(over);
  const out: string[] = [];
  const err: string[] = [];
  const slept: number[] = [];
  const code = await main(
    argv,
    { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env },
    {
      cwd,
      now: () => NOW,
      fetcher: { transport: w.transport },
      cost: { sleep: async (ms: number) => void slept.push(ms) },
    } as never,
  );
  return { code, out: out.join(""), err: err.join(""), seen: w.seen, slept };
}

const lines = (text: string) => text.split("\n");

describe("gaugeline cost: end to end (recorded responses)", () => {
  it("prints the summary by likely cause first, then the findings, and exits 0 without --ci", async () => {
    const r = await run(["cost", "marlowe-bar.example", "--no-open", "--quiet"], folder(BAR));
    expect(r.code).toBe(EXIT.ok);
    const text = lines(r.out);
    expect(text.slice(0, 6)).toEqual([
      "Hosting cost for marlowe-bar.example",
      "Pages, likeliest cause of cost first",
      "  /specials  This page changes on every visit because it prints the current time; caching can't help it.",
      "  /events    This page is marked static but it is never served from the CDN's cache, so the host builds it again for every visitor.",
      "  /menu      This page is marked static, but its cache lifetime is 1 second, so the host rebuilds it about every second instead of keeping the last copy.",
      "  Fine: /",
    ]);
    expect(r.out).toContain("Vercel: Billed cost was 2.1 USD on 10 Nov 2026");
    expect(r.out).toContain(
      "Vercel: Fast Data Transfer was 41 GB on 10 Nov 2026, 3.4 times its average of 12 GB",
    );
    expect(r.out).toContain("Hosting usage jumped");
    expect(r.out).toContain("The page's HTML is different on every request");
  });

  it("waits a few seconds between the two visits (an injected sleep here)", async () => {
    const r = await run(["cost", "marlowe-bar.example", "--no-open", "--quiet"], folder(BAR));
    expect(r.slept.length).toBeGreaterThan(0);
    expect(r.slept.every((ms) => ms === 3000)).toBe(true);
  });

  it("--ci exits 0 when nothing is fix first (these are medium and low)", async () => {
    const r = await run(
      ["cost", "marlowe-bar.example", "--ci", "--no-open", "--quiet"],
      folder(BAR),
    );
    expect(r.code).toBe(EXIT.ok);
  });

  it("--json prints the schema 2 result and nothing else, with no key in it", async () => {
    const r = await run(
      ["cost", "marlowe-bar.example", "--json", "--no-open", "--quiet"],
      folder(BAR),
    );
    expect(r.out.startsWith("{")).toBe(true);
    const parsed = resultSchema.parse(JSON.parse(r.out));
    expect(parsed.findings.map((f) => f.checkId).sort()).toEqual([
      "never-cached",
      "output-changes-every-request",
      "revalidate-too-often",
      "usage-jump",
      "usage-jump",
    ]);
    expect(r.out).not.toContain(VERCEL_TOKEN);
    expect(r.out).not.toContain("Hosting cost for");
  });

  it("with no usage token says so as could-not-check and still judges the pages", async () => {
    const r = await run(["cost", "marlowe-bar.example", "--no-open", "--quiet"], folder(BAR), {
      NO_COLOR: "1",
    });
    expect(r.out).toContain("Vercel: could not check: GAUGELINE_VERCEL_TOKEN is not set");
    expect(r.out).toMatch(/usage-jump could not be checked/);
    expect(r.out).toContain("/specials  This page changes on every visit");
    expect(r.seen.some((s) => s.url.includes("api.vercel.com"))).toBe(false);
  });

  it("asks only GET, and sends the key to api.vercel.com only", async () => {
    const r = await run(["cost", "marlowe-bar.example", "--no-open", "--quiet"], folder(BAR));
    expect(new Set(r.seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    for (const s of r.seen) {
      expect(s.url).not.toContain(VERCEL_TOKEN);
      expect(s.headers.authorization !== undefined).toBe(
        new URL(s.url).hostname === "api.vercel.com",
      );
    }
  });

  it("with no settings file it judges the page itself and says no page is marked static", async () => {
    const r = await run(["cost", "marlowe-bar.example", "--no-open", "--quiet"], folder());
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('"static"');
    expect(r.out).toContain("Fine: /");
  });

  it("a gaugeline.cost.json that does not read is exit 2, naming the file", async () => {
    const r = await run(
      ["cost", "marlowe-bar.example", "--no-open"],
      folder('{"static":["menu"]}'),
    );
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("gaugeline.cost.json");
  });

  it("a site on a hosted builder: usage is not applicable and no usage API is asked", async () => {
    const r = await run(
      ["cost", "ember-popup.example", "--no-open", "--quiet"],
      folder(),
      ENV,
      POPUP,
    );
    expect(r.out).toContain("Not applicable: fixed plan. Wix charges one plan price");
    expect(r.out).not.toMatch(/could not check/);
    expect(r.seen.some((s) => s.url.includes("api.vercel.com"))).toBe(false);
    expect(r.out).toContain("This page changes on every visit");
  });
});

describe("the page check with --cost, and the nightly run", () => {
  it("adds the cost checks to the page check only when asked", async () => {
    const dir = folder(BAR);
    const without = await run(["marlowe-bar.example", "--json", "--no-open", "--quiet"], dir);
    const ids = (text: string) =>
      resultSchema.parse(JSON.parse(text)).findings.map((f) => f.checkId);
    expect(ids(without.out)).not.toContain("output-changes-every-request");
    expect(without.seen.some((s) => s.url.includes("api.vercel.com"))).toBe(false);
    expect(without.slept).toEqual([]);
    const withIt = await run(
      ["marlowe-bar.example", "--cost", "--json", "--no-open", "--quiet"],
      dir,
    );
    expect(ids(withIt.out)).toEqual(
      expect.arrayContaining(["output-changes-every-request", "never-cached", "usage-jump"]),
    );
    expect(withIt.out).not.toContain("Hosting cost for");
  });

  it("run --all --cost hands the flag to every site's run", async () => {
    const dir = folder();
    mkdirSync(join(dir, "runs"));
    const seen: string[][] = [];
    const site = {
      name: "marlowe-bar",
      address: "https://marlowe-bar.example",
      host: "marlowe-bar.example",
      configDir: dir,
      permission: { by: "Maya Ortiz, owner of Marlowe Bar", on: "2026-11-01" },
    };
    const runOne = async (argv: string[]) => {
      seen.push(argv);
      return 0;
    };
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, cost: true, runOne });
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, runOne });
    expect(seen[0]).toContain("--cost");
    expect(seen[1]).not.toContain("--cost");
  });

  it("parses --cost on the page check and on run, and the cost command", () => {
    const a = parseCliArgs(["marlowe-bar.example", "--cost"], {});
    expect(a.kind === "run" && a.cost).toBe(true);
    const b = parseCliArgs(["cost", "marlowe-bar.example"], {});
    expect(b.kind === "run" && b.cost && b.command).toBe("cost");
    const c = parseCliArgs(["run", "--all", "--cost"], {});
    expect(c.kind === "run-all" && c.cost).toBe(true);
    const d = parseCliArgs(["marlowe-bar.example"], {});
    expect(d.kind === "run" && d.cost).toBe(false);
  });

  it("needs one address", () => {
    expect(parseCliArgs(["cost"], {}).kind).toBe("error");
  });
});

describe("cost: help and flags", () => {
  it("has its own help, which lists the flags it accepts", () => {
    const help = HELP.cost ?? "";
    expect(help).toContain("gaugeline cost <address>");
    expect(help).toContain("--ci");
    expect(help).toContain("--json");
    expect(help).toContain("GAUGELINE_VERCEL_TOKEN");
    expect(help).not.toContain("--dns");
  });

  it("the --cost flag is on the page check and on run, and described the same in help and docs", () => {
    const flag = FLAGS.find((f) => f.name === "cost");
    expect(flag?.commands).toEqual(["check", "run"]);
    expect(HELP[""]).toContain("--cost");
  });
});
