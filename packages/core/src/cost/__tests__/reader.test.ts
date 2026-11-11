import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { buildSnapshot } from "../../snapshot.js";
import { createCost } from "../reader.js";
import { BAR_CONFIG, BAR_PAGES, CHARGES_URL_TEAM, ENV, JUMPED, NOW, world } from "./world.js";

function setup(
  over: Parameters<typeof world>[0] = {},
  config: Parameters<typeof createCost>[0]["config"] = {},
  env = ENV,
) {
  const w = world(over);
  const fetcher = createFetcher({ transport: w.transport });
  const slept: number[] = [];
  const cost = createCost(
    { config, env, now: () => NOW, sleep: async (ms) => void slept.push(ms) },
    fetcher,
  );
  return { ...w, fetcher, cost, slept };
}

async function snapshotOf(fetcher: ReturnType<typeof createFetcher>, address: string) {
  return buildSnapshot(await fetcher.getSite(address));
}

describe("cost.pages: two visits a few seconds apart", () => {
  it("the checked page's first visit is the one already made: one new GET, after a wait", async () => {
    const s = setup();
    const snapshot = await snapshotOf(s.fetcher, "marlowe-bar.example");
    expect(s.visits.get("/")).toBe(1);
    const reads = await s.cost.pages(snapshot);
    expect(s.visits.get("/")).toBe(2);
    expect(s.slept).toEqual([3000]);
    expect(reads).toHaveLength(1);
    const [r] = reads;
    expect(r).toMatchObject({
      ok: true,
      path: "/",
      url: "https://marlowe-bar.example/",
      gapMs: 3000,
    });
  });

  it("reads once: a second call is the same answer and no more requests", async () => {
    const s = setup();
    const snapshot = await snapshotOf(s.fetcher, "marlowe-bar.example");
    const a = await s.cost.pages(snapshot);
    const before = s.seen.length;
    const b = await s.cost.pages(snapshot);
    expect(b).toBe(a);
    expect(s.seen.length).toBe(before);
  });

  it("also reads the pages the settings list, twice each, GET only, on the same site", async () => {
    const s = setup({}, BAR_CONFIG);
    const snapshot = await snapshotOf(s.fetcher, "marlowe-bar.example");
    const reads = await s.cost.pages(snapshot);
    expect(reads.map((r) => r.path)).toEqual(["/", "/specials", "/menu", "/events"]);
    expect(s.visits.get("/specials")).toBe(2);
    expect(s.visits.get("/menu")).toBe(2);
    expect(new Set(s.seen.map((x) => x.method))).toEqual(new Set(["GET"]));
    expect(reads.map((r) => r.ok && r.markedStatic)).toEqual([true, false, true, true]);
  });

  it("the listed page that is the checked page is read once", async () => {
    const s = setup({}, { pages: ["/"] });
    const snapshot = await snapshotOf(s.fetcher, "marlowe-bar.example");
    expect((await s.cost.pages(snapshot)).map((r) => r.path)).toEqual(["/"]);
  });

  it("marks a page static by its path, query ignored, and a trailing * matches a folder", async () => {
    const s = setup(
      { pages: { ...BAR_PAGES, "/blog/post-1": { body: () => "<p>a</p>" } } },
      { static: ["/menu", "/blog/*"], pages: ["/menu", "/blog/post-1"] },
    );
    const snapshot = await snapshotOf(s.fetcher, "marlowe-bar.example");
    const reads = await s.cost.pages(snapshot);
    expect(reads.map((r) => [r.path, r.ok && r.markedStatic])).toEqual([
      ["/", false],
      ["/menu", true],
      ["/blog/post-1", true],
    ]);
  });

  it("a listed page that answers 404 is read like any other: the verdicts say it cannot be judged", async () => {
    const s = setup({ pages: { "/": BAR_PAGES["/"]! } }, { pages: ["/missing"] });
    const snapshot = await snapshotOf(s.fetcher, "marlowe-bar.example");
    const reads = await s.cost.pages(snapshot);
    expect(reads.map((r) => r.ok)).toEqual([true, true]);
    expect(reads[1]).toMatchObject({ ok: true, path: "/missing", second: { status: 404 } });
  });

  it("a page whose request fails is a read with the reason, and the others are still read", async () => {
    const w = world();
    const fetcher = createFetcher({
      transport: (url, req) =>
        url.pathname === "/boom"
          ? Promise.reject(Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }))
          : w.transport(url, req),
    });
    const cost = createCost(
      { config: { pages: ["/boom"] }, env: ENV, now: () => NOW, sleep: async () => undefined },
      fetcher,
    );
    const reads = await cost.pages(await snapshotOf(fetcher, "marlowe-bar.example"));
    expect(reads[0]?.ok).toBe(true);
    expect(reads[1]).toMatchObject({ ok: false, path: "/boom" });
  });
});

describe("cost.usage: only from what the user configured", () => {
  it("with no token at all says what to set, and asks nothing", async () => {
    const s = setup({}, {}, { NO_COLOR: "1" } as never);
    const read = await s.cost.usage();
    expect(read.providers.every((p) => !p.ok)).toBe(true);
    expect(read.providers.map((p) => p.provider)).toEqual(["Vercel", "Sanity"]);
    expect(s.seen).toHaveLength(0);
  });

  it("reads Vercel with the team from the settings, once", async () => {
    const s = setup({ charges: { [CHARGES_URL_TEAM]: { status: 200, body: JUMPED } } }, BAR_CONFIG);
    const a = await s.cost.usage();
    const b = await s.cost.usage();
    expect(b).toBe(a);
    expect(a.providers[0]).toMatchObject({ ok: true, provider: "Vercel" });
    expect(s.seen.filter((x) => x.url.startsWith("https://api.vercel.com"))).toHaveLength(1);
  });

  it("the window and multiple come from the settings, with defaults", async () => {
    const s = setup({}, { usage: { window: 7, multiple: 3 } });
    expect(s.cost.usageSettings).toEqual({ window: 7, multiple: 3 });
    expect(setup().cost.usageSettings).toEqual({ window: 14, multiple: 2 });
  });
});
