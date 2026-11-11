import { describe, expect, it } from "vitest";
import { COST_CHECKS } from "../../checks/cost.js";
import { createFetcher } from "../../fetcher.js";
import { buildResult } from "../../result.js";
import { checkSite } from "../../site.js";
import { createCost } from "../reader.js";
import { createCostRegistry } from "../registry.js";
import { buildCostSummary, formatCostSummary } from "../summary.js";
import {
  BAR_CONFIG,
  CHARGES_URL_TEAM,
  ENV,
  JUMPED,
  NOW,
  STEADY,
  VERCEL_TOKEN,
  type PageSpec,
  world,
} from "./world.js";

async function run(
  over: Parameters<typeof world>[0] = {},
  config: Parameters<typeof createCost>[0]["config"] = BAR_CONFIG,
  env: Record<string, string> = ENV,
) {
  const w = world(over);
  const fetcher = createFetcher({ transport: w.transport });
  const cost = createCost({ config, env, now: () => NOW, sleep: async () => undefined }, fetcher);
  const check = await checkSite({
    address: "marlowe-bar.example",
    fetcher,
    registry: createCostRegistry(),
    only: COST_CHECKS.map((c) => c.id),
    cost,
    now: () => NOW,
  });
  return { check, cost, ...w };
}

const ids = (r: Awaited<ReturnType<typeof run>>) =>
  r.check.result.findings.map(
    (f) => `${f.checkId} ${new URL(f.url, "https://x.example").pathname}`,
  );

describe("cost: integration (recorded responses)", () => {
  it("finds the page that prints the time, the static page that never hits, the short lifetime and the usage jump", async () => {
    const r = await run({ charges: { [CHARGES_URL_TEAM]: { status: 200, body: JUMPED } } });
    expect(r.check.result.findings.map((f) => `${f.checkId} ${f.url}`).sort()).toEqual(
      [
        "never-cached https://marlowe-bar.example/events",
        "output-changes-every-request https://marlowe-bar.example/specials",
        "revalidate-too-often https://marlowe-bar.example/menu",
        "usage-jump usage:vercel:Billed cost",
        "usage-jump usage:vercel:Fast Data Transfer",
      ].sort(),
    );
    expect(
      r.check.result.findings.find((f) => f.checkId === "output-changes-every-request")?.evidence,
    ).toContain("2026-11-11T09:00:");
  });

  it("a page that differs only by a nonce, and one that is stable, are not flagged", async () => {
    const r = await run();
    const changed = r.check.result.findings.filter(
      (f) => f.checkId === "output-changes-every-request",
    );
    expect(changed.map((f) => f.url)).toEqual(["https://marlowe-bar.example/specials"]);
    // "/" has a different nonce on every visit and a MISS then a HIT: nothing at all.
    expect(ids(r).some((x) => x.endsWith(" /"))).toBe(false);
  });

  it("steady usage is not a finding", async () => {
    const r = await run({ charges: { [CHARGES_URL_TEAM]: { status: 200, body: STEADY } } });
    expect(r.check.result.findings.filter((f) => f.checkId === "usage-jump")).toEqual([]);
    expect(r.check.result.passed).toContain("usage-jump");
  });

  it("with no usage token the account-level check is could-not-check and the page-level checks still run", async () => {
    const r = await run({}, BAR_CONFIG, { NO_COLOR: "1" });
    const notes = r.check.result.couldNotCheck.filter((n) => n.id === "usage-jump");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toContain("GAUGELINE_VERCEL_TOKEN");
    expect(r.check.result.passed).not.toContain("usage-jump");
    expect(r.check.result.findings.map((f) => f.checkId)).toContain("output-changes-every-request");
    expect(r.seen.some((s) => s.url.startsWith("https://api.vercel.com"))).toBe(false);
  });

  it("a refused token is could-not-check for Vercel with the reason, and no key anywhere in the result", async () => {
    const r = await run({
      charges: { [CHARGES_URL_TEAM]: { status: 403, body: `{"error":"${VERCEL_TOKEN}"}` } },
    });
    expect(r.check.result.couldNotCheck.find((n) => n.url === "usage:vercel")?.reason).toContain(
      "HTTP 403",
    );
    const json = JSON.stringify(
      buildResult({
        url: "https://marlowe-bar.example/",
        startedAt: NOW,
        findings: r.check.result.findings,
        passed: r.check.result.passed,
        failed: r.check.result.failed.map((f) => f.id),
        couldNotCheck: r.check.result.couldNotCheck,
        sampled: r.check.result.sampled,
      }),
    );
    expect(json).not.toContain(VERCEL_TOKEN);
  });

  it("asks only with GET, and the key goes to api.vercel.com in a header and nowhere else", async () => {
    const r = await run();
    expect(new Set(r.seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    for (const s of r.seen) {
      expect(s.url).not.toContain(VERCEL_TOKEN);
      const sent = s.headers.authorization !== undefined;
      expect(sent).toBe(new URL(s.url).hostname === "api.vercel.com");
    }
  });

  it("is the same on every run: same input, same findings", async () => {
    const a = await run();
    const b = await run();
    expect(b.check.result.findings).toEqual(a.check.result.findings);
  });

  it("the summary names the pages by likely cause in plain sentences", async () => {
    const r = await run({ charges: { [CHARGES_URL_TEAM]: { status: 200, body: JUMPED } } });
    const reads = await r.cost.pages(r.check.snapshot);
    const usage = await r.cost.usage();
    const lines = formatCostSummary(
      buildCostSummary({
        site: "marlowe-bar.example",
        reads,
        usage,
        now: NOW,
        minimumSeconds: 60,
        usageSettings: r.cost.usageSettings,
      }),
    );
    expect(lines[2]).toBe(
      "  /specials  This page changes on every visit because it prints the current time; caching can't help it.",
    );
    expect(lines.some((l) => l.includes("Fast Data Transfer was 41 GB on 10 Nov 2026"))).toBe(true);
  });
});

describe("cost: a page that varies by an A/B test cookie", () => {
  const variantByRequest: PageSpec = {
    body: (n) =>
      `<!doctype html><title>Menu</title><h1>${n % 2 === 0 ? "Spring" : "Summer"} menu</h1>`,
    perVisit: (n) => ({ "set-cookie": `ab_variant=${n % 2 === 0 ? "A" : "B"}; Path=/` }),
    headers: { "content-type": "text/html" },
  };

  it("is flagged, with a note that both visits were sent without cookies", async () => {
    const r = await run({ pages: { "/": variantByRequest } }, {});
    const f = r.check.result.findings.find((x) => x.checkId === "output-changes-every-request");
    expect(f?.evidence).toMatch(/ab_variant/);
    expect(f?.evidence).toMatch(/without cookies/);
    expect(r.seen.every((s) => s.headers.cookie === undefined)).toBe(true);
  });

  it("is not flagged when the server gives a visitor with no cookie the same variant each time", async () => {
    const r = await run(
      {
        pages: {
          "/": {
            body: () => "<!doctype html><title>Menu</title><h1>Spring menu</h1>",
            headers: { "content-type": "text/html", "set-cookie": "ab_variant=A; Path=/" },
          },
        },
      },
      {},
    );
    expect(r.check.result.findings).toEqual([]);
  });
});

describe("cost: a hosted builder has a fixed plan", () => {
  const wix = {
    body: (n: number) =>
      `<!doctype html><title>Pop-up</title><meta name="generator" content="Wix.com Website Builder"><p>${n}</p>`,
    headers: { "content-type": "text/html", "x-wix-request-id": "1699-abc" },
  };

  it("usage is not applicable (no finding, no could-not-check, no request to a usage API), the page checks still run", async () => {
    const r = await run({ pages: { "/": wix } }, {}, { NO_COLOR: "1" });
    expect(r.check.result.couldNotCheck.filter((n) => n.id === "usage-jump")).toEqual([]);
    expect(r.check.result.passed).toContain("usage-jump");
    expect(r.check.result.findings.map((f) => f.checkId)).toEqual(["output-changes-every-request"]);
    expect(r.seen.some((s) => s.url.startsWith("https://api.vercel.com"))).toBe(false);
  });
});
