import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { detectJumps } from "../usage.js";
import { readSanityUsage, readVercelUsage } from "../providers.js";
import {
  CHARGES_URL,
  CHARGES_URL_TEAM,
  ENV,
  JUMPED,
  NOW,
  SANITY_TOKEN,
  STEADY,
  VERCEL_TOKEN,
  world,
} from "./world.js";

const fetcherFor = (over: Parameters<typeof world>[0] = {}) => {
  const w = world(over);
  return { fetcher: createFetcher({ transport: w.transport }), seen: w.seen };
};

const args = { env: ENV, now: NOW, window: 14, teamId: "team_harbour01" };

describe("readVercelUsage (recorded billing charges)", () => {
  it("asks for the fifteen complete days before today, with one GET and the key in a header", async () => {
    const { fetcher, seen } = fetcherFor();
    await readVercelUsage({ ...args, fetcher });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${CHARGES_URL_TEAM}`]);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${VERCEL_TOKEN}`);
    expect(seen[0]?.url).not.toContain(VERCEL_TOKEN);
  });

  it("without a team id it asks for the token's own account", async () => {
    const { fetcher, seen } = fetcherFor({
      charges: { [CHARGES_URL]: { status: 200, body: STEADY } },
    });
    const read = await readVercelUsage({ ...args, teamId: undefined, fetcher });
    expect(read.ok).toBe(true);
    expect(seen[0]?.url).toBe(CHARGES_URL);
  });

  it("a steady account has the usage but no jump", async () => {
    const { fetcher } = fetcherFor();
    const read = await readVercelUsage({ ...args, fetcher });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.provider).toBe("Vercel");
    expect(read.metrics.map((m) => `${m.name} (${m.unit})`).sort()).toEqual([
      "Billed cost (USD)",
      "Edge Requests (Requests)",
      "Fast Data Transfer (GB)",
    ]);
    const fdt = read.metrics.find((m) => m.name === "Fast Data Transfer");
    expect(fdt?.daily.size).toBe(15);
    expect(fdt?.daily.get("2026-11-10")).toBe(12_000);
    expect(detectJumps(read.metrics, NOW, {})).toEqual([]);
  });

  it("a jump in one metric is found, and only that one", async () => {
    const { fetcher } = fetcherFor({
      charges: { [CHARGES_URL_TEAM]: { status: 200, body: JUMPED } },
    });
    const read = await readVercelUsage({ ...args, fetcher });
    if (!read.ok) throw new Error(read.reason);
    const jumps = detectJumps(read.metrics, NOW, {});
    expect(jumps.map((j) => [j.metric, j.unit, j.latest, j.average])).toEqual([
      ["Billed cost", "USD", 2_050, 600],
      ["Fast Data Transfer", "GB", 41_000, 12_000],
    ]);
  });

  it("adds up several rows for one service and day, in thousandths", async () => {
    const row = (q: number, c: number) =>
      JSON.stringify({
        ServiceName: "Function Duration",
        ConsumedQuantity: q,
        ConsumedUnit: "Hours",
        BilledCost: c,
        BillingCurrency: "USD",
        ChargePeriodStart: "2026-11-10T00:00:00.000Z",
      });
    const { fetcher } = fetcherFor({
      charges: {
        [CHARGES_URL_TEAM]: { status: 200, body: `${row(0.25, 0.01)}\n${row(0.5, 0.02)}\n` },
      },
    });
    const read = await readVercelUsage({ ...args, fetcher });
    if (!read.ok) throw new Error(read.reason);
    expect(read.metrics.find((m) => m.name === "Function Duration")?.daily.get("2026-11-10")).toBe(
      750,
    );
    expect(read.metrics.find((m) => m.name === "Billed cost")?.daily.get("2026-11-10")).toBe(30);
  });

  it("an account with no charges in the period is read, with no metrics", async () => {
    const { fetcher } = fetcherFor({ charges: { [CHARGES_URL_TEAM]: { status: 200, body: "" } } });
    expect(await readVercelUsage({ ...args, fetcher })).toMatchObject({ ok: true, metrics: [] });
  });

  it("is could-not-check, naming the variable, when there is no token, and asks nothing", async () => {
    const { fetcher, seen } = fetcherFor();
    const read = await readVercelUsage({ ...args, env: {}, fetcher });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toContain("GAUGELINE_VERCEL_TOKEN");
      expect(read.asked).toBe(false);
      expect(read.configured).toBe(false);
    }
    expect(seen).toHaveLength(0);
  });

  it.each([
    [401, /refused the token \(HTTP 401\)/],
    [403, /refused the token \(HTTP 403\)/],
    [429, /slow down \(HTTP 429\)/],
    [500, /HTTP 500/],
  ])("a %i is could-not-check with the reason, and no body in it", async (status, reason) => {
    const { fetcher } = fetcherFor({
      charges: {
        [CHARGES_URL_TEAM]: {
          status,
          body: `{"error":"${VERCEL_TOKEN}"}`,
          headers: { "retry-after": "60" },
        },
      },
    });
    const read = await readVercelUsage({ ...args, fetcher });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.asked).toBe(true);
    expect(read.reason).toMatch(reason);
    expect(read.reason).not.toContain(VERCEL_TOKEN);
  });

  it("a 429 says when to try again", async () => {
    const { fetcher } = fetcherFor({
      charges: { [CHARGES_URL_TEAM]: { status: 429, headers: { "retry-after": "60" } } },
    });
    const read = await readVercelUsage({ ...args, fetcher });
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain("in 60 seconds");
  });

  it("an answer in a shape it does not know is could-not-check, never a guess", async () => {
    const { fetcher } = fetcherFor({
      charges: {
        [CHARGES_URL_TEAM]: { status: 200, body: '{"usage":{"bandwidth":12}}\n{"x":1}\n' },
      },
    });
    const read = await readVercelUsage({ ...args, fetcher });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/something Gaugeline cannot read/);
  });

  it("a line that is not JSON is could-not-check", async () => {
    const { fetcher } = fetcherFor({
      charges: { [CHARGES_URL_TEAM]: { status: 200, body: "<html>sign in</html>" } },
    });
    const read = await readVercelUsage({ ...args, fetcher });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/not JSON|cannot read/);
  });

  it("never sends anything but GET", async () => {
    const { fetcher, seen } = fetcherFor();
    await readVercelUsage({ ...args, fetcher });
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
  });
});

describe("readSanityUsage", () => {
  it("is could-not-check, naming the variable, when there is no token", async () => {
    const { fetcher, seen } = fetcherFor();
    const read = await readSanityUsage({ env: {}, fetcher, now: NOW, window: 14 });
    expect(read).toMatchObject({ ok: false, asked: false, configured: false, provider: "Sanity" });
    if (!read.ok) expect(read.reason).toContain("SANITY_TOKEN");
    expect(seen).toHaveLength(0);
  });

  it("with a token says plainly that no documented read endpoint was confirmed, and asks nothing", async () => {
    const { fetcher, seen } = fetcherFor();
    const read = await readSanityUsage({
      env: { SANITY_TOKEN },
      fetcher,
      now: NOW,
      window: 14,
    });
    expect(read).toMatchObject({ ok: false, asked: false, configured: true, provider: "Sanity" });
    if (!read.ok) {
      expect(read.reason).toMatch(/documented/);
      expect(read.reason).not.toContain(SANITY_TOKEN);
    }
    expect(seen).toHaveLength(0);
  });
});
