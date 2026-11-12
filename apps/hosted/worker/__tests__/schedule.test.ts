/**
 * The 03:00 fan-out, with pg_cron stood in for: pg_cron would call private.enqueue_nightly() every 15
 * minutes (as the owner that scheduled it); these tests make the same call for each tick of a stretch of
 * time and look at the jobs it made. No extension is enabled anywhere (0004 registers with pg_cron only
 * when the extension is there).
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  seed,
  type Sql,
  type TestDatabase,
} from "../../db/__tests__/harness.js";

const TICK_MS = 15 * 60_000;

describe.skipIf(!HAS_DATABASE)("nightly fan-out (pg_cron stand-in)", () => {
  let db: TestDatabase;
  let sql: Sql;

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await sql`delete from public.jobs`;
  });

  /** One pg_cron call every 15 minutes from `from` (inclusive) to `to` (exclusive). */
  async function tick(from: string, to: string): Promise<void> {
    for (let t = Date.parse(from); t < Date.parse(to); t += TICK_MS)
      await sql`select private.enqueue_nightly(${new Date(t)})`;
  }

  /** The nightly jobs of a site: its local date and the local time the job was made. */
  async function nights(siteId: string) {
    return sql`select j.scheduled_for::text as night,
        to_char(j.run_after at time zone s.timezone, 'HH24:MI') as local
      from public.jobs j join public.sites s on s.id = j.site_id
      where j.site_id = ${siteId} and j.kind = 'nightly' order by j.scheduled_for`;
  }

  async function addSite(name: string, timezone: string, createdAt?: string): Promise<string> {
    const host = `${name.toLowerCase().replace(/[^a-z]+/g, "-")}.test`;
    const rows = await sql`insert into public.sites (org_id, name, url, timezone, created_at)
      values (${ORG_A}, ${name}, ${`https://${host}`}, ${timezone}, ${createdAt ?? new Date().toISOString()})
      returning id`;
    return rows[0]!.id as string;
  }

  it("one job per site per local night, made at 03:00 in the site's own zone", async () => {
    const london = await addSite("Harbour Coffee Cart", "Europe/London");
    const toronto = await addSite("Queen West Barbers", "America/Toronto");
    await tick("2026-11-12T00:00:00Z", "2026-11-15T00:00:00Z");
    expect(await nights(london)).toEqual([
      { night: "2026-11-12", local: "03:00" },
      { night: "2026-11-13", local: "03:00" },
      { night: "2026-11-14", local: "03:00" },
    ]);
    // 03:00 in Toronto is 08:00 UTC; the stretch ends at 19:00 Toronto time on the 14th.
    expect(await nights(toronto)).toEqual([
      { night: "2026-11-12", local: "03:00" },
      { night: "2026-11-13", local: "03:00" },
      { night: "2026-11-14", local: "03:00" },
    ]);
  });

  // Clocks change at 01:00 UTC in London and at 02:00 local time in Toronto, both directions.
  it.each([
    ["Europe/London", "spring forward", "2027-03-27T00:00:00Z", "2027-03-30T00:00:00Z"],
    ["Europe/London", "fall back", "2026-10-24T00:00:00Z", "2026-10-27T00:00:00Z"],
    ["America/Toronto", "spring forward", "2027-03-13T06:00:00Z", "2027-03-16T06:00:00Z"],
    ["America/Toronto", "fall back", "2026-10-31T06:00:00Z", "2026-11-03T06:00:00Z"],
  ])("%s, %s: no night runs twice and none is skipped", async (zone, label, from, to) => {
    const site = await addSite(`Corner Deli ${zone} ${label}`, zone);
    await tick(from, to);
    const got = await nights(site);
    expect(got.map((n) => n.local)).toEqual(["03:00", "03:00", "03:00"]);
    const dates = got.map((n) => Date.parse(`${n.night as string}T00:00:00Z`));
    expect(dates[1]! - dates[0]!).toBe(86_400_000);
    expect(dates[2]! - dates[1]!).toBe(86_400_000);
  });

  it("calling twice in the same minute (an overlapping cron run) makes one job", async () => {
    const site = await addSite("Bramble Florist", "Europe/London");
    await sql`select private.enqueue_nightly(${new Date("2026-11-12T03:00:00Z")})`;
    await sql`select private.enqueue_nightly(${new Date("2026-11-12T03:00:00Z")})`;
    expect(await nights(site)).toHaveLength(1);
  });

  it("a site added at 02:59 is checked that night; one added at 08:00 waits for the next", async () => {
    const early = await addSite("Night Market Stall", "Europe/London", "2026-11-12T02:59:00Z");
    await tick("2026-11-12T02:45:00Z", "2026-11-12T03:15:00Z");
    expect(await nights(early)).toEqual([{ night: "2026-11-12", local: "03:00" }]);

    const late = await addSite("Lantern Yoga", "Europe/London", "2026-11-12T08:00:00Z");
    await tick("2026-11-12T08:00:00Z", "2026-11-13T03:15:00Z");
    expect(await nights(late)).toEqual([{ night: "2026-11-13", local: "03:00" }]);
  });

  it("a missed call is caught up before 07:00, not after", async () => {
    const site = await addSite("Copper Kettle Cafe", "Europe/London");
    await sql`select private.enqueue_nightly(${new Date("2026-11-12T05:30:00Z")})`;
    await sql`select private.enqueue_nightly(${new Date("2026-11-13T07:00:00Z")})`;
    expect(await nights(site)).toEqual([{ night: "2026-11-12", local: "05:30" }]);
  });

  it("a paused site gets no job, and an unknown zone does not stop the other sites", async () => {
    const paused = await addSite("Shuttered Pop-up", "Europe/London");
    await sql`update public.sites set active = false where id = ${paused}`;
    const odd = await addSite("Moonbase Diner", "Mars/Olympus_Mons");
    const fine = await addSite("Riverside Bakery", "Europe/London");
    const made =
      await sql`select private.enqueue_nightly(${new Date("2026-11-12T03:00:00Z")}) as n`;
    expect(made[0]!.n).toBeGreaterThan(0);
    expect(await nights(paused)).toEqual([]);
    expect(await nights(odd)).toEqual([]);
    expect(await nights(fine)).toHaveLength(1);
    await sql`update public.sites set active = true where id = ${paused}`;
  });

  it("a zone spelled in the wrong case still gets its night; a name Postgres does not know is counted, not guessed", async () => {
    const skipped = async () =>
      Number((await sql`select private.skipped_nightly_sites() as n`)[0]!.n);
    const before = await skipped();
    const lower = await addSite("Kiln Lane Pottery", "europe/london");
    const utc = await addSite("Dockside Fish Bar", "utc");
    const nonsense = await addSite("Atlantis Spa", "Atlantis/Lost_City");
    expect(await skipped()).toBe(before + 1);
    await sql`select private.enqueue_nightly(${new Date("2026-11-12T03:00:00Z")})`;
    expect(await nights(lower)).toEqual([{ night: "2026-11-12", local: "03:00" }]);
    expect(await nights(utc)).toHaveLength(1);
    expect(await nights(nonsense)).toEqual([]);
    // The fan-out says how many it left out, in the database's log, without naming a zone.
    const notices: string[] = [];
    const watching = postgres(db.url, { max: 1, onnotice: (n) => notices.push(String(n.message)) });
    try {
      await watching`select private.enqueue_nightly(${new Date("2026-11-12T03:15:00Z")})`;
    } finally {
      await watching.end();
    }
    expect(notices.join("\n")).toMatch(/\d+ active site\(s\) skipped/);
    expect(notices.join("\n")).not.toMatch(/Atlantis/);
  });

  it("the stand-in for pg_cron receives one schedule: every 15 minutes, the fan-out", async () => {
    // 0004 calls private.schedule_nightly() itself when pg_cron is installed. Here a stand-in cron.schedule
    // records what it is given, the way the real one stores a job (job name, schedule, command).
    await sql.unsafe(`
      create schema cron;
      create table cron.stand_in (job_name text, schedule text, command text);
      create function cron.schedule(job_name text, schedule text, command text) returns bigint
        language sql as $$ insert into cron.stand_in values (job_name, schedule, command); select 1::bigint $$;
    `);
    await sql`select private.schedule_nightly()`;
    expect(await sql`select * from cron.stand_in`).toEqual([
      {
        job_name: "gaugeline-nightly",
        schedule: "*/15 * * * *",
        command: "select private.enqueue_nightly()",
      },
    ]);
    await sql.unsafe(`drop schema cron cascade`);
  });

  it("nobody but the owner can call the fan-out or touch jobs", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      expect(
        await errorOf(as(sql, { role }, (tx) => tx`select private.enqueue_nightly()`)),
        role,
      ).toMatch(/permission denied/);
      expect(
        await errorOf(as(sql, { role }, (tx) => tx`select private.skipped_nightly_sites()`)),
        role,
      ).toMatch(/permission denied/);
    }
    for (const role of ["anon", "authenticated"] as const) {
      expect(
        await errorOf(as(sql, { role }, (tx) => tx`select id from public.jobs`)),
        role,
      ).toMatch(/permission denied/);
    }
    expect(
      await errorOf(as(sql, { role: "service_role" }, (tx) => tx`delete from public.jobs`)),
    ).toMatch(/permission denied/);
  });
});
