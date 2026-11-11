import { describe, expect, it } from "vitest";
import { readSanityBackups, readSupabaseBackups } from "../providers.js";

const NOW = new Date("2026-11-11T09:00:00Z");
import {
  ENV,
  REF,
  SANITY_TOKEN_VALUE,
  SANITY_URL,
  SUPABASE_TOKEN,
  SUPABASE_URL,
  fetcherFor,
  sanityBackups,
  supabaseOff,
  supabaseOn,
  supabasePitr,
} from "./world.js";

const supabase = (routes: Parameters<typeof fetcherFor>[0], env: Record<string, string> = ENV) => {
  const f = fetcherFor(routes);
  return {
    ...f,
    read: () => readSupabaseBackups({ env, fetcher: f.fetcher, projectRef: REF, now: NOW }),
  };
};

describe("readSupabaseBackups (recorded responses)", () => {
  it("asks with one GET, the token in a header and never in the address", async () => {
    const { read, seen } = supabase({
      [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOn("2026-11-10T03:00:00Z") },
    });
    await read();
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${SUPABASE_URL}`]);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${SUPABASE_TOKEN}`);
    expect(seen[0]?.url).not.toContain(SUPABASE_TOKEN);
  });

  it("backups on: the newest completed one is the latest, a failed one is not a backup", async () => {
    const { read } = supabase({
      [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOn("2026-11-10T03:00:00Z") },
    });
    expect(await read()).toMatchObject({
      ok: true,
      platform: "Supabase",
      enabled: true,
      latest: "2026-11-10T03:00:00.000Z",
      detail: "daily backups on, point-in-time recovery off",
    });
  });

  it("backups on but stale: still read as on, with the old date", async () => {
    const { read } = supabase({
      [`GET ${SUPABASE_URL}`]: {
        status: 200,
        body: supabaseOn("2026-10-25T03:00:00Z", {
          backups: [
            { status: "COMPLETED", inserted_at: "2026-10-25T03:00:00Z", is_physical_backup: false },
          ],
        }),
      },
    });
    expect(await read()).toMatchObject({
      ok: true,
      enabled: true,
      latest: "2026-10-25T03:00:00.000Z",
    });
  });

  it("backups off: not enabled, no date", async () => {
    const { read } = supabase({ [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOff } });
    const got = await read();
    expect(got).toMatchObject({ ok: true, enabled: false });
    expect(got.ok && got.latest).toBeUndefined();
  });

  it("point-in-time recovery: the latest restorable moment is the date", async () => {
    const { read } = supabase({
      [`GET ${SUPABASE_URL}`]: { status: 200, body: supabasePitr("2026-11-11T08:55:00Z") },
    });
    expect(await read()).toMatchObject({
      ok: true,
      enabled: true,
      latest: "2026-11-11T08:55:00.000Z",
      detail: "daily backups on, point-in-time recovery on",
    });
  });

  it("an answer in another shape is could-not-check, never a guess", async () => {
    const { read } = supabase({
      [`GET ${SUPABASE_URL}`]: { status: 200, body: { hello: "world" } },
    });
    expect(await read()).toMatchObject({ ok: false, configured: true });
  });

  it.each([401, 403])(
    "HTTP %i (a token that may not read this) is could-not-check, only for Supabase",
    async (status) => {
      const { read } = supabase({ [`GET ${SUPABASE_URL}`]: { status } });
      const got = await read();
      expect(got).toMatchObject({ ok: false, configured: true, platform: "Supabase" });
      expect(got.ok ? "" : got.reason).toContain(`HTTP ${status}`);
    },
  );

  it("an error message never holds the token", async () => {
    const { read } = supabase({
      [`GET ${SUPABASE_URL}`]: {
        status: 500,
        body: `boom ${SUPABASE_TOKEN}`,
      },
    });
    const got = await read();
    expect(JSON.stringify(got)).not.toContain(SUPABASE_TOKEN);
  });

  it("with no token it asks nothing and says which variable to set", async () => {
    const { read, seen } = supabase({}, {});
    expect(await read()).toMatchObject({ ok: false, configured: true });
    expect(seen).toEqual([]);
    const got = await read();
    expect(got.ok ? "" : got.reason).toContain("SUPABASE_ACCESS_TOKEN");
  });
});

const sanity = (
  routes: Parameters<typeof fetcherFor>[0],
  env: Record<string, string> = ENV,
  args = {},
) => {
  const f = fetcherFor(routes);
  return { ...f, read: () => readSanityBackups({ env, fetcher: f.fetcher, now: NOW, ...args }) };
};

describe("readSanityBackups (recorded responses)", () => {
  it("reads the dataset's backups with one GET and the key in a header", async () => {
    const { read, seen } = sanity({
      [`GET ${SANITY_URL}`]: {
        status: 200,
        body: sanityBackups("2026-11-09T02:00:00Z", "2026-11-10T02:00:00Z"),
      },
    });
    expect(await read()).toMatchObject({
      ok: true,
      platform: "Sanity",
      subject: "dataset production",
      enabled: true,
      latest: "2026-11-10T02:00:00.000Z",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${SANITY_TOKEN_VALUE}`);
  });

  it("no backups listed is reported as none, not as a guess about the plan", async () => {
    const { read } = sanity({ [`GET ${SANITY_URL}`]: { status: 200, body: sanityBackups() } });
    const got = await read();
    expect(got).toMatchObject({ ok: true, enabled: false });
    expect(got.ok && got.detail).toContain("lists no backups");
  });

  it("uses the dataset from the settings or SANITY_DATASET", async () => {
    const url = "https://api.sanity.io/v2021-06-07/projects/marlowe1/datasets/staging/backups";
    const { read } = sanity(
      { [`GET ${url}`]: { status: 200, body: sanityBackups("2026-11-10T02:00:00Z") } },
      ENV,
      { dataset: "staging" },
    );
    expect(await read()).toMatchObject({ ok: true, subject: "dataset staging" });
  });

  it("a plan or token that cannot see backups is could-not-check with the status", async () => {
    for (const status of [402, 403, 404]) {
      const { read } = sanity({ [`GET ${SANITY_URL}`]: { status } }, ENV, { explicit: true });
      const got = await read();
      expect(got).toMatchObject({ ok: false, configured: true, platform: "Sanity" });
    }
  });

  it("without the project id or the token it asks nothing", async () => {
    const a = sanity({}, { SANITY_TOKEN: SANITY_TOKEN_VALUE });
    expect(await a.read()).toMatchObject({ ok: false, configured: false });
    const b = sanity({}, { SANITY_PROJECT_ID: "marlowe1" }, { explicit: true });
    expect(await b.read()).toMatchObject({ ok: false, configured: true });
    expect(a.seen.length + b.seen.length).toBe(0);
  });
});

describe("times that cannot be trusted", () => {
  it("a future-dated backup is not the latest: the real one is, and the future one is counted", async () => {
    const { read } = supabase({
      [`GET ${SUPABASE_URL}`]: {
        status: 200,
        body: supabaseOn("2099-01-01T00:00:00Z", {
          backups: [
            { status: "COMPLETED", inserted_at: "2099-01-01T00:00:00Z" },
            { status: "COMPLETED", inserted_at: "2026-01-01T00:00:00Z" },
          ],
        }),
      },
    });
    const got = await read();
    expect(got).toMatchObject({
      ok: true,
      enabled: true,
      latest: "2026-01-01T00:00:00.000Z",
      future: 1,
    });
  });

  it("a time a few hours ahead (a clock a little off) is still trusted", async () => {
    const { read } = supabase({
      [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOn("2026-11-11T20:00:00Z") },
    });
    expect(await read()).toMatchObject({ ok: true, latest: "2026-11-11T20:00:00.000Z" });
  });

  it("only a future backup: on, with no date, so it is never judged recent", async () => {
    const { read } = supabase({
      [`GET ${SUPABASE_URL}`]: {
        status: 200,
        body: supabaseOn("x", {
          walg_enabled: false,
          backups: [{ status: "COMPLETED", inserted_at: "2099-01-01T00:00:00Z" }],
        }),
      },
    });
    const got = await read();
    expect(got).toMatchObject({ ok: true, enabled: true, future: 1 });
    expect(got.ok && got.latest).toBeUndefined();
  });

  it("a huge number is an unknown time, not an exception", async () => {
    const { read } = supabase({
      [`GET ${SUPABASE_URL}`]: {
        status: 200,
        body: supabaseOn("x", {
          backups: [
            { status: "COMPLETED", inserted_at: 1e20 },
            { status: "COMPLETED", inserted_at: 8.64e15 },
            { status: "COMPLETED", inserted_at: "2026-11-10T03:00:00Z" },
          ],
        }),
      },
    });
    expect(await read()).toMatchObject({ ok: true, latest: "2026-11-10T03:00:00.000Z" });
    const pitr = supabase({
      [`GET ${SUPABASE_URL}`]: {
        status: 200,
        body: {
          walg_enabled: false,
          pitr_enabled: true,
          physical_backup_data: { latest_physical_backup_date_unix: 1e20 },
        },
      },
    });
    await expect(pitr.read()).resolves.toMatchObject({ ok: true });
    const sane = sanity({
      [`GET ${SANITY_URL}`]: {
        status: 200,
        body: { backups: [{ createdAt: 1e20 }, { createdAt: "9999-12-31T00:00:00Z" }] },
      },
    });
    await expect(sane.read()).resolves.toMatchObject({ ok: true });
  });

  it("Sanity: a future-dated backup is not the latest either", async () => {
    const { read } = sanity({
      [`GET ${SANITY_URL}`]: {
        status: 200,
        body: sanityBackups("2099-01-01T00:00:00Z", "2026-10-01T02:00:00Z"),
      },
    });
    expect(await read()).toMatchObject({ ok: true, latest: "2026-10-01T02:00:00.000Z", future: 1 });
  });
});

describe("Sanity pages (the paging fields are uncited: see the docs page)", () => {
  it("follows nextCursor and takes the newest over every page", async () => {
    const { read, seen } = sanity({
      [`GET ${SANITY_URL}`]: {
        status: 200,
        body: { backups: [{ createdAt: "2026-10-01T02:00:00Z" }], nextCursor: "c2" },
      },
      [`GET ${SANITY_URL}?nextCursor=c2`]: {
        status: 200,
        body: { backups: [{ createdAt: "2026-11-10T02:00:00Z" }] },
      },
    });
    const got = await read();
    expect(got).toMatchObject({ ok: true, latest: "2026-11-10T02:00:00.000Z" });
    expect(got.ok && got.partial).toBeUndefined();
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
  });

  it("a hard page cap: still more pages after it is partial, never complete", async () => {
    const routes: Record<string, { status: number; body: unknown }> = {};
    for (let i = 0; i < 10; i++)
      routes[`GET ${SANITY_URL}${i === 0 ? "" : `?nextCursor=c${i}`}`] = {
        status: 200,
        body: { backups: [{ createdAt: "2026-10-01T02:00:00Z" }], nextCursor: `c${i + 1}` },
      };
    const { read, seen } = sanity(routes);
    const got = await read();
    expect(seen.length).toBeLessThanOrEqual(5);
    expect(got).toMatchObject({ ok: true });
    expect(got.ok && got.partial).toContain("more backups");
  });

  it("a page that fails after the first is partial, with the newest of what was read", async () => {
    const { read } = sanity({
      [`GET ${SANITY_URL}`]: {
        status: 200,
        body: { backups: [{ createdAt: "2026-10-01T02:00:00Z" }], nextCursor: "c2" },
      },
      [`GET ${SANITY_URL}?nextCursor=c2`]: { status: 500 },
    });
    const got = await read();
    expect(got).toMatchObject({ ok: true, latest: "2026-10-01T02:00:00.000Z" });
    expect(got.ok && got.partial).toBeDefined();
  });

  it("a full page of 100 with no cursor may be only the first page", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      createdAt: `2026-0${1 + (i % 9)}-01T00:00:00Z`,
    }));
    const { read } = sanity({ [`GET ${SANITY_URL}`]: { status: 200, body: { backups: rows } } });
    const got = await read();
    expect(got.ok && got.partial).toBeDefined();
  });
});
