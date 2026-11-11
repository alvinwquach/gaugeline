import { describe, expect, it } from "vitest";
import type { CheckContext } from "../../model.js";
import type { Observation, PageRead } from "../../cost/judge.js";
import type { Cost } from "../../cost/reader.js";
import type { UsageRead } from "../../cost/usage.js";
import {
  COST_CHECKS,
  neverCached,
  outputChangesEveryRequest,
  revalidateTooOften,
  usageJump,
} from "../cost.js";
import { page } from "./helpers.js";

const NOW = new Date("2026-11-11T09:00:00Z");
const PAGE = page({ finalUrl: "https://marlowe-bar.example/specials" });

const obs = (body: string, headers: Record<string, string> = {}, status = 200): Observation => ({
  status,
  headers: { "content-type": "text/html", ...headers },
  body,
});

const readOf = (
  first: Observation,
  second: Observation,
  over: { path?: string; markedStatic?: boolean } = {},
): PageRead => ({
  ok: true,
  url: `https://marlowe-bar.example${over.path ?? "/specials"}`,
  path: over.path ?? "/specials",
  markedStatic: over.markedStatic ?? false,
  first,
  second,
  gapMs: 3000,
});

interface Fake {
  reads?: PageRead[];
  builder?: { id: "wix"; name: string };
  usage?: UsageRead;
  staticPages?: string[];
  minimumSeconds?: number;
  usageSettings?: { window: number; multiple: number };
}

function fake(f: Fake): Cost {
  return {
    config: {
      ...(f.staticPages ? { static: f.staticPages } : {}),
      ...(f.minimumSeconds !== undefined ? { minimumSeconds: f.minimumSeconds } : {}),
    },
    usageSettings: f.usageSettings ?? { window: 14, multiple: 2 },
    pages: async () => f.reads ?? [],
    builder: () => f.builder,
    usage: async () => f.usage ?? { providers: [] },
  };
}

function context(cost?: Cost) {
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    now: () => NOW,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(cost ? { cost } : {}),
  };
  return { ctx, notes };
}

describe("the cost checks do nothing without --cost", () => {
  it.each(COST_CHECKS.map((c) => [c.id, c] as const))(
    "%s finds nothing and notes nothing",
    async (_id, check) => {
      const { ctx, notes } = context();
      expect(await check.run(PAGE, ctx)).toEqual([]);
      expect(notes).toEqual([]);
    },
  );

  it("there are four, with the ids the spec names", () => {
    expect(COST_CHECKS.map((c) => c.id)).toEqual([
      "output-changes-every-request",
      "never-cached",
      "revalidate-too-often",
      "usage-jump",
    ]);
    expect(COST_CHECKS.map((c) => c.severity)).toEqual(["medium", "low", "low", "medium"]);
  });
});

describe("output-changes-every-request", () => {
  it("flags the page that prints a timestamp, with the first difference as evidence", async () => {
    const { ctx } = context(
      fake({
        reads: [
          readOf(
            obs("<p>Updated 2026-11-11T09:00:03Z</p>"),
            obs("<p>Updated 2026-11-11T09:00:08Z</p>"),
          ),
        ],
      }),
    );
    const found = await outputChangesEveryRequest.run(PAGE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "output-changes-every-request",
      severity: "medium",
      url: "https://marlowe-bar.example/specials",
    });
    expect(found[0]?.evidence).toContain("2026-11-11T09:00:08Z");
    expect(found[0]?.evidence).toContain("looks like a time");
  });

  it("does not flag a stable page, or one that differs only by a nonce", async () => {
    const stable = obs("<p>Menu</p>");
    const nonce = (n: string) => obs(`<script nonce="${n}"></script><p>Menu</p>`);
    const { ctx, notes } = context(
      fake({ reads: [readOf(stable, stable), readOf(nonce("a"), nonce("b"), { path: "/menu" })] }),
    );
    expect(await outputChangesEveryRequest.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("a page that could not be read is could-not-check with the reason, and the others are judged", async () => {
    const { ctx, notes } = context(
      fake({
        reads: [
          {
            ok: false,
            url: "https://marlowe-bar.example/boom",
            path: "/boom",
            reason: "the connection was reset",
          },
          readOf(obs("<p>a 1</p>"), obs("<p>a 2</p>")),
        ],
      }),
    );
    expect(await outputChangesEveryRequest.run(PAGE, ctx)).toHaveLength(1);
    expect(notes).toEqual([
      { url: "https://marlowe-bar.example/boom", reason: "the connection was reset" },
    ]);
  });

  it("a visit that was not a page is could-not-check", async () => {
    const { ctx, notes } = context(fake({ reads: [readOf(obs("x"), obs("x", {}, 503))] }));
    expect(await outputChangesEveryRequest.run(PAGE, ctx)).toEqual([]);
    expect(notes[0]?.reason).toMatch(/HTTP 503/);
  });

  it("still runs on a hosted builder: the page-level checks hurt speed there too", async () => {
    const { ctx } = context(
      fake({
        builder: { id: "wix", name: "Wix" },
        reads: [readOf(obs("<p>1</p>"), obs("<p>2</p>"))],
      }),
    );
    expect(await outputChangesEveryRequest.run(PAGE, ctx)).toHaveLength(1);
  });
});

describe("never-cached", () => {
  const miss = obs("<p>a</p>", { "x-vercel-cache": "MISS" });
  const hit = obs("<p>a</p>", { "x-vercel-cache": "HIT" });

  it("flags a page marked static whose two visits both missed", async () => {
    const { ctx } = context(
      fake({
        staticPages: ["/events"],
        reads: [readOf(miss, miss, { path: "/events", markedStatic: true })],
      }),
    );
    const found = await neverCached.run(PAGE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "never-cached", severity: "low" });
    expect(found[0]?.evidence).toContain("x-vercel-cache: MISS");
  });

  it("does not flag a page that was a hit, or one that is not marked static", async () => {
    const { ctx, notes } = context(
      fake({
        staticPages: ["/menu"],
        reads: [
          readOf(miss, hit, { path: "/menu", markedStatic: true }),
          readOf(miss, miss, { path: "/specials", markedStatic: false }),
        ],
      }),
    );
    expect(await neverCached.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("with no page marked static says what to set, once, and finds nothing", async () => {
    const { ctx, notes } = context(fake({ reads: [readOf(miss, miss)] }));
    expect(await neverCached.run(PAGE, ctx)).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toContain("gaugeline.cost.json");
    expect(notes[0]?.reason).toContain('"static"');
  });

  it("no cache header on a static page is could-not-check", async () => {
    const bare = obs("<p>a</p>");
    const { ctx, notes } = context(
      fake({
        staticPages: ["/menu"],
        reads: [readOf(bare, bare, { path: "/menu", markedStatic: true })],
      }),
    );
    expect(await neverCached.run(PAGE, ctx)).toEqual([]);
    expect(notes[0]?.reason).toMatch(/x-vercel-cache, cf-cache-status or age/);
  });
});

describe("revalidate-too-often", () => {
  const cc = (value: string) =>
    obs("<p>a</p>", { "cache-control": value, "x-vercel-cache": "STALE" });

  it("flags a lifetime under the configured minimum on a page marked static", async () => {
    const short = cc("public, s-maxage=1, stale-while-revalidate=59");
    const { ctx } = context(
      fake({
        staticPages: ["/menu"],
        reads: [readOf(short, short, { path: "/menu", markedStatic: true })],
      }),
    );
    const found = await revalidateTooOften.run(PAGE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "revalidate-too-often", severity: "low" });
    expect(found[0]?.evidence).toContain("s-maxage=1");
  });

  it("uses the configured minimum, 60 seconds by default", async () => {
    const five = cc("public, s-maxage=300");
    const reads = [readOf(five, five, { path: "/menu", markedStatic: true })];
    expect(
      await revalidateTooOften.run(PAGE, context(fake({ staticPages: ["/menu"], reads })).ctx),
    ).toEqual([]);
    expect(
      await revalidateTooOften.run(
        PAGE,
        context(fake({ staticPages: ["/menu"], minimumSeconds: 600, reads })).ctx,
      ),
    ).toHaveLength(1);
  });

  it("does not flag a long lifetime or a page that is not marked static", async () => {
    const long = cc("public, s-maxage=3600");
    const short = cc("public, s-maxage=1");
    const { ctx } = context(
      fake({
        staticPages: ["/menu"],
        reads: [readOf(long, long, { path: "/menu", markedStatic: true }), readOf(short, short)],
      }),
    );
    expect(await revalidateTooOften.run(PAGE, ctx)).toEqual([]);
  });

  it("no Cache-Control on a static page is could-not-check; no static pages is said once", async () => {
    const bare = obs("<p>a</p>");
    const a = context(
      fake({
        staticPages: ["/menu"],
        reads: [readOf(bare, bare, { path: "/menu", markedStatic: true })],
      }),
    );
    expect(await revalidateTooOften.run(PAGE, a.ctx)).toEqual([]);
    expect(a.notes[0]?.reason).toMatch(/no Cache-Control/);
    const b = context(fake({ reads: [readOf(bare, bare)] }));
    expect(await revalidateTooOften.run(PAGE, b.ctx)).toEqual([]);
    expect(b.notes).toHaveLength(1);
  });
});

describe("usage-jump", () => {
  const day = (i: number) => new Date(Date.UTC(2026, 9, 27 + i)).toISOString().slice(0, 10);
  const metric = (name: string, unit: string, latest: number, avg: number) => ({
    name,
    unit,
    daily: new Map(
      Array.from(
        { length: 15 },
        (_, i) => [day(i), Math.round((i === 14 ? latest : avg) * 1000)] as const,
      ),
    ),
  });

  it("flags a metric more than the multiple of its trailing average, in plain words", async () => {
    const { ctx } = context(
      fake({
        usage: {
          providers: [
            {
              ok: true,
              provider: "Vercel",
              metrics: [
                metric("Fast Data Transfer", "GB", 41, 12),
                metric("Edge Requests", "Requests", 90_000, 90_000),
              ],
            },
            {
              ok: false,
              provider: "Sanity",
              asked: false,
              configured: false,
              reason: "SANITY_TOKEN is not set",
            },
          ],
        },
      }),
    );
    const found = await usageJump.run(PAGE, ctx);
    expect(found).toEqual([
      {
        checkId: "usage-jump",
        severity: "medium",
        title: "Hosting usage jumped",
        evidence:
          "Vercel Fast Data Transfer was 41 GB on 10 Nov 2026, 3.4 times its average of 12 GB over the 14 days before (flagged above 2 times)",
        url: "usage:vercel:Fast Data Transfer",
      },
    ]);
  });

  it("each provider that could not be read is could-not-check for that provider only", async () => {
    const { ctx, notes } = context(
      fake({
        usage: {
          providers: [
            {
              ok: false,
              provider: "Vercel",
              asked: true,
              configured: true,
              reason: "Vercel refused the token (HTTP 403) when asked for the billing charges",
            },
            {
              ok: false,
              provider: "Sanity",
              asked: false,
              configured: true,
              reason: "Sanity has no documented read API for usage",
            },
          ],
        },
      }),
    );
    expect(await usageJump.run(PAGE, ctx)).toEqual([]);
    expect(notes.map((n) => n.url)).toEqual(["usage:vercel", "usage:sanity"]);
    expect(notes[0]?.reason).toContain("HTTP 403");
  });

  it("with no token anywhere it is one could-not-check that names every variable", async () => {
    const { ctx, notes } = context(
      fake({
        usage: {
          providers: [
            {
              ok: false,
              provider: "Vercel",
              asked: false,
              configured: false,
              reason: "GAUGELINE_VERCEL_TOKEN is not set, so Vercel was not asked",
            },
            {
              ok: false,
              provider: "Sanity",
              asked: false,
              configured: false,
              reason: "SANITY_TOKEN is not set, so Sanity was not asked",
            },
          ],
        },
      }),
    );
    expect(await usageJump.run(PAGE, ctx)).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toContain("GAUGELINE_VERCEL_TOKEN");
    expect(notes[0]?.reason).toContain("SANITY_TOKEN");
  });

  it("on a hosted builder it is not applicable: no finding and no could-not-check", async () => {
    const { ctx, notes } = context(
      fake({
        builder: { id: "wix", name: "Wix" },
        usage: {
          providers: [
            { ok: false, provider: "Vercel", asked: false, configured: false, reason: "no token" },
          ],
        },
      }),
    );
    expect(await usageJump.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("a steady account has no finding", async () => {
    const { ctx, notes } = context(
      fake({
        usage: {
          providers: [
            { ok: true, provider: "Vercel", metrics: [metric("Fast Data Transfer", "GB", 12, 12)] },
          ],
        },
      }),
    );
    expect(await usageJump.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });
});
