import { describe, expect, it } from "vitest";
import { readSanityBackups, readSupabaseBackups } from "../providers.js";
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
  return { ...f, read: () => readSupabaseBackups({ env, fetcher: f.fetcher, projectRef: REF }) };
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
  return { ...f, read: () => readSanityBackups({ env, fetcher: f.fetcher, ...args }) };
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
