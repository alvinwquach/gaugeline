import { describe, expect, it } from "vitest";
import type { CheckContext } from "../../model.js";
import { createBackups } from "../../backups/reader.js";
import type { BackupsConfig } from "../../backups/config.js";
import type { ExportLister, RawExportFile, RawListing } from "../../backups/types.js";
import { buildBackupsSummary, formatBackupsSummary } from "../../backups/summary.js";
import {
  ENV,
  NOW,
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
} from "../../backups/__tests__/world.js";
import { BACKUPS_CHECKS, backupsNotEnabled, exportTooSmall, noRecentBackup } from "../backups.js";
import { page } from "./helpers.js";

const PAGE = page({ finalUrl: "https://marlowe-bar.example/" });

type Routes = Parameters<typeof fetcherFor>[0];

function run(opts: {
  config?: BackupsConfig;
  routes?: Routes;
  env?: Record<string, string>;
  files?: Record<string, RawExportFile[] | RawListing | Error>;
  off?: boolean;
}) {
  const { fetcher, seen } = fetcherFor(opts.routes ?? {});
  const lister: ExportLister = (folder) => {
    const f = opts.files?.[folder];
    if (f instanceof Error) return Promise.reject(f);
    return Promise.resolve(f ?? []);
  };
  const backups = createBackups(
    {
      config: opts.config ?? {},
      env: opts.env ?? (opts.config?.supabase ? { SUPABASE_ACCESS_TOKEN: SUPABASE_TOKEN } : ENV),
      lister,
    },
    fetcher,
  );
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    now: () => NOW,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(opts.off ? {} : { backups }),
  };
  const all = async () => {
    const found = [];
    for (const c of BACKUPS_CHECKS) found.push(...(await c.run(PAGE, ctx)));
    return found;
  };
  return { ctx, notes, seen, backups, all };
}

const SUPA: BackupsConfig = { supabase: { projectRef: REF } };
const file = (name: string, size: number, modified = "2026-11-10T03:00:00Z"): RawExportFile => ({
  name,
  size,
  modified,
});

describe("the backups checks do nothing without --backups", () => {
  it("finds nothing, notes nothing and asks nothing", async () => {
    const r = run({ config: SUPA, off: true });
    expect(await r.all()).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.seen).toEqual([]);
  });

  it("there are three, with the ids the spec names", () => {
    expect(BACKUPS_CHECKS.map((c) => c.id)).toEqual([
      "no-recent-backup",
      "backups-not-enabled",
      "export-too-small",
    ]);
  });
});

describe("Supabase (recorded responses)", () => {
  it("backups on and recent: no findings", async () => {
    const r = run({
      config: SUPA,
      routes: {
        [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOn("2026-11-10T03:00:00Z") },
      },
    });
    expect(await r.all()).toEqual([]);
    expect(r.notes.filter((n) => n.url.startsWith("backups:supabase"))).toEqual([]);
  });

  it("backups off: backups-not-enabled, once, and nothing about age", async () => {
    const r = run({
      config: SUPA,
      routes: { [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOff } },
    });
    const found = await r.all();
    expect(found.map((f) => f.checkId)).toEqual(["backups-not-enabled"]);
    expect(found[0]).toMatchObject({ severity: "high", url: "backups:supabase" });
    expect(found[0]?.evidence).toContain("daily backups off, point-in-time recovery off");
  });

  it("stale backups: no-recent-backup with the age, the date and the limit", async () => {
    const r = run({
      config: SUPA,
      routes: {
        [`GET ${SUPABASE_URL}`]: {
          status: 200,
          body: supabaseOn("2026-10-30T03:00:00Z", {
            backups: [{ status: "COMPLETED", inserted_at: "2026-10-30T03:00:00Z" }],
          }),
        },
      },
    });
    const found = await r.all();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "no-recent-backup", severity: "high" });
    expect(found[0]?.evidence).toBe(
      "Supabase project abcdefghijklmnopqrst: the newest backup was 12 days ago (30 Oct 2026); more than 7 days is flagged",
    );
  });

  it("the limit is the settings' maxAgeDays", async () => {
    const routes = {
      [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOn("2026-11-08T03:00:00Z") },
    };
    expect(await run({ config: { ...SUPA, maxAgeDays: 1 }, routes }).all()).toHaveLength(1);
    expect(await run({ config: { ...SUPA, maxAgeDays: 4 }, routes }).all()).toHaveLength(0);
  });

  it("point-in-time recovery counts as recent", async () => {
    const r = run({
      config: SUPA,
      routes: {
        [`GET ${SUPABASE_URL}`]: { status: 200, body: supabasePitr("2026-11-11T08:55:00Z") },
      },
    });
    expect(await r.all()).toEqual([]);
  });

  it("a token without permission is could-not-check with the reason, not a finding, and never holds the token", async () => {
    const r = run({ config: SUPA, routes: { [`GET ${SUPABASE_URL}`]: { status: 403 } } });
    expect(await r.all()).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]?.url).toBe("backups:supabase");
    expect(r.notes[0]?.reason).toContain("HTTP 403");
    expect(JSON.stringify(r.notes)).not.toContain(SUPABASE_TOKEN);
  });

  it("only GET is sent", async () => {
    const r = run({
      config: SUPA,
      routes: { [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOff } },
    });
    await r.all();
    expect(r.seen.map((s) => s.method)).toEqual(["GET"]);
  });
});

describe("Sanity (recorded responses)", () => {
  it("read from the environment alone; a stale backup is a finding", async () => {
    const r = run({
      routes: {
        [`GET ${SANITY_URL}`]: { status: 200, body: sanityBackups("2026-10-01T02:00:00Z") },
      },
    });
    const found = await r.all();
    expect(found.map((f) => f.checkId)).toEqual(["no-recent-backup"]);
  });

  it("a plan that does not expose backups is silent when Sanity was not asked for, noted when it was", async () => {
    const routes = { [`GET ${SANITY_URL}`]: { status: 402 } };
    const quiet = run({
      routes,
      config: { exports: [{ folder: "x" }] },
      files: { x: [file("a-2026-11-10.sql", 5)] },
    });
    await quiet.all();
    expect(quiet.notes).toEqual([]);
    const asked = run({ routes, config: { sanity: {} } });
    await asked.all();
    expect(asked.notes.map((n) => n.url)).toEqual(["backups:sanity"]);
    expect(JSON.stringify(asked.notes)).not.toContain(SANITY_TOKEN_VALUE);
  });
});

describe("export folders", () => {
  const cfg: BackupsConfig = { exports: [{ name: "database", folder: "backups/db" }] };

  it("a shrinking file: export-too-small names both files and sizes", async () => {
    const r = run({
      config: cfg,
      env: {},
      files: {
        "backups/db": [
          file("db-2026-11-08.sql.gz", 95_000),
          file("db-2026-11-09.sql.gz", 94_000),
          file("db-2026-11-10.sql.gz", 12_000),
        ],
      },
    });
    const found = await r.all();
    expect(found.map((f) => f.checkId)).toEqual(["export-too-small"]);
    expect(found[0]?.evidence).toBe(
      'Export "database" (backups/db): db-2026-11-10.sql.gz is 12 KB, under 50% of db-2026-11-09.sql.gz before it (94 KB)',
    );
    expect(found[0]?.severity).toBe("medium");
  });

  it("a steady folder has no finding", async () => {
    const r = run({
      config: cfg,
      env: {},
      files: {
        "backups/db": [file("db-2026-11-09.sql.gz", 94_000), file("db-2026-11-10.sql.gz", 95_000)],
      },
    });
    expect(await r.all()).toEqual([]);
  });

  it("an old newest file is no-recent-backup; the date from the name, or from the file's time with a note", async () => {
    const named = run({
      config: cfg,
      env: {},
      files: { "backups/db": [file("db-2026-10-20.sql.gz", 10)] },
    });
    expect((await named.all())[0]?.evidence).toContain("dated 22 days ago (20 Oct 2026)");
    const undated = run({
      config: cfg,
      env: {},
      files: { "backups/db": [file("latest.sql.gz", 10, "2026-10-20T01:00:00Z")] },
    });
    expect((await undated.all())[0]?.evidence).toContain("its name has no date");
  });

  it("an empty folder is no-recent-backup", async () => {
    const r = run({ config: cfg, env: {}, files: { "backups/db": [] } });
    const found = await r.all();
    expect(found.map((f) => f.checkId)).toEqual(["no-recent-backup"]);
    expect(found[0]?.evidence).toContain("no backup files");
  });

  it("a folder that cannot be read is could-not-check with the reason", async () => {
    const r = run({
      config: cfg,
      env: {},
      files: { "backups/db": new Error("ENOENT: no such folder") },
    });
    expect(await r.all()).toEqual([]);
    expect(r.notes[0]).toMatchObject({ url: "backups:export:database" });
    expect(r.notes[0]?.reason).toContain("ENOENT");
  });
});

describe("nothing set up", () => {
  it("is one could-not-check naming what to set up, not a pass", async () => {
    const r = run({ env: {} });
    expect(await r.all()).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]?.reason).toContain("SUPABASE_ACCESS_TOKEN");
  });

  it("another page of the same site reports nothing again", async () => {
    const r = run({
      config: SUPA,
      routes: { [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOff } },
    });
    await r.all();
    expect(
      await backupsNotEnabled.run(page({ finalUrl: "https://marlowe-bar.example/menu" }), r.ctx),
    ).toEqual([]);
    expect(
      await noRecentBackup.run(page({ finalUrl: "https://marlowe-bar.example/menu" }), r.ctx),
    ).toEqual([]);
    expect(
      await exportTooSmall.run(page({ finalUrl: "https://marlowe-bar.example/menu" }), r.ctx),
    ).toEqual([]);
  });
});

describe("summary and checklist", () => {
  it("lists each source, then the systems whose backups cannot be read", async () => {
    const wix = page({
      finalUrl: "https://ember-popup.example/",
      hops: [
        {
          url: "https://ember-popup.example/",
          status: 200,
          headers: { "x-wix-request-id": "1" },
          ms: 1,
        },
      ],
    });
    const r = run({
      config: { ...SUPA, exports: [{ name: "database", folder: "d" }] },
      routes: {
        [`GET ${SUPABASE_URL}`]: { status: 200, body: supabaseOn("2026-11-10T03:00:00Z") },
      },
      files: { d: [file("db-2026-11-10.sql.gz", 2_000_000)] },
    });
    const reading = await r.backups.read(NOW);
    const lines = formatBackupsSummary(
      buildBackupsSummary({ site: "ember-popup.example", reading, page: wix, now: NOW }),
    );
    expect(lines).toEqual([
      "Backups for ember-popup.example",
      "  Supabase project abcdefghijklmnopqrst: daily backups on, point-in-time recovery off. Newest backup 1 day ago (10 Nov 2026).",
      '  Export "database" (d): 1 file, newest db-2026-11-10.sql.gz, 2 MB, dated 1 day ago (10 Nov 2026).',
      "Check by hand",
      expect.stringContaining("[ ] Wix: Gaugeline cannot read Wix's backup status"),
    ]);
  });

  it("with nothing read and nothing recognised, the checklist says to write down where backups are", async () => {
    const r = run({ env: {} });
    const reading = await r.backups.read(NOW);
    const s = buildBackupsSummary({ site: "x.example", reading, page: PAGE, now: NOW });
    expect(s.lines).toEqual(["No backup source is set up, so no backup status was read."]);
    expect(s.checklist[0]?.line).toContain("Write down where");
  });
});

describe("times and files that cannot be trusted", () => {
  const cfg: BackupsConfig = { exports: [{ name: "database", folder: "backups/db" }] };
  const only = (checkId: string, found: { checkId: string }[]) =>
    found.filter((f) => f.checkId === checkId);

  it("a future-dated platform backup does not hide a stale real one, and is noted", async () => {
    const r = run({
      config: SUPA,
      routes: {
        [`GET ${SUPABASE_URL}`]: {
          status: 200,
          body: supabaseOn("x", {
            backups: [
              { status: "COMPLETED", inserted_at: "2099-01-01T00:00:00Z" },
              { status: "COMPLETED", inserted_at: "2026-01-01T00:00:00Z" },
            ],
          }),
        },
      },
    });
    const found = await r.all();
    expect(found.map((f) => f.checkId)).toEqual(["no-recent-backup"]);
    expect(found[0]?.evidence).toContain("1 Jan 2026");
    expect(r.notes.map((n) => n.reason).join(" ")).toContain("dated in the future");
    const s = buildBackupsSummary({
      site: "x",
      reading: await r.backups.read(NOW),
      page: PAGE,
      now: NOW,
    });
    expect(s.lines.join(" ")).not.toContain("2099");
    expect(s.lines.join(" ")).toContain("future");
  });

  it("a future-dated export file name or time does not hide a stale one", async () => {
    for (const files of [
      [file("db-2099-01-01.sql", 10), file("db-2026-01-01.sql", 10)],
      [file("a.sql", 10, "2099-01-01T00:00:00Z"), file("db-2026-01-01.sql", 10)],
    ]) {
      const r = run({ config: cfg, env: {}, files: { "backups/db": files } });
      const found = await r.all();
      expect(only("no-recent-backup", found)).toHaveLength(1);
      expect(found[0]?.evidence).toContain("1 Jan 2026");
      expect(r.notes.map((n) => n.reason).join(" ")).toContain("dated in the future");
    }
  });

  it("only future files: no export is judged, so could-not-check and no finding of freshness", async () => {
    const r = run({
      config: cfg,
      env: {},
      files: { "backups/db": [file("db-2099-01-01.sql", 10)] },
    });
    const found = await r.all();
    expect(found.map((f) => f.evidence).join(" ")).not.toContain("2099");
    expect(r.notes.map((n) => n.reason).join(" ")).toContain("dated in the future");
  });

  it("only dump files count: dotfiles, READMEs and logs touched today do not make a folder fresh", async () => {
    const r = run({
      config: cfg,
      env: {},
      files: {
        "backups/db": [
          file("db-2026-10-01.sql.gz", 10),
          file(".DS_Store", 6000, "2026-11-11T08:00:00Z"),
          file("README.txt", 10, "2026-11-11T08:00:00Z"),
          file("cron.log", 10, "2026-11-11T08:00:00Z"),
          file(".gitkeep", 0, "2026-11-11T08:00:00Z"),
        ],
      },
    });
    const found = await r.all();
    expect(found.map((f) => f.checkId)).toEqual(["no-recent-backup"]);
    expect(found[0]?.evidence).toContain("db-2026-10-01.sql.gz");
  });

  it("a folder of only non-backup files says so, as a finding naming how many were skipped", async () => {
    const r = run({
      config: cfg,
      env: {},
      files: { "backups/db": [file("README.txt", 10), file(".DS_Store", 10)] },
    });
    const found = await r.all();
    expect(found[0]?.evidence).toContain("2 files were skipped");
  });

  it("a configured pattern replaces the extension list", async () => {
    const r = run({
      config: { exports: [{ name: "database", folder: "backups/db", pattern: "dump-*.txt" }] },
      env: {},
      files: { "backups/db": [file("dump-2026-11-10.txt", 10), file("db-2026-11-10.sql", 10)] },
    });
    expect(await r.all()).toEqual([]);
    const reading = await r.backups.read(NOW);
    expect(reading.exports[0]).toMatchObject({ ok: true, skipped: 1 });
  });

  it("1,500 dumps with the newest listed last is not a false stale finding", async () => {
    const files: RawExportFile[] = [];
    for (let i = 0; i < 1500; i++) {
      const d = new Date(Date.parse("2026-11-10T00:00:00Z") - (1499 - i) * 86_400_000);
      files.push(file(`db-${d.toISOString().slice(0, 10)}.sql`, 100, d.toISOString()));
    }
    const r = run({ config: cfg, env: {}, files: { "backups/db": files } });
    expect(await r.all()).toEqual([]);
  });

  it("a listing cut short by the reader is could-not-check, never a stale finding", async () => {
    const r = run({
      config: cfg,
      env: {},
      files: { "backups/db": { files: [file("db-2026-01-01.sql", 10)], truncated: true } },
    });
    expect(await r.all()).toEqual([]);
    expect(r.notes[0]?.reason).toContain("more entries");
  });

  it("links and folders that were not read are said, and with nothing readable left it is could-not-check", async () => {
    const some = run({
      config: cfg,
      env: {},
      files: { "backups/db": { files: [file("db-2026-11-10.sql", 10)], unread: 2 } },
    });
    expect(await some.all()).toEqual([]);
    expect(some.notes[0]?.reason).toContain("2 entries were not read (links or folders)");
    const none = run({
      config: cfg,
      env: {},
      files: { "backups/db": { files: [], unread: 3 } },
    });
    expect(await none.all()).toEqual([]);
    expect(none.notes[0]?.reason).toContain("3 entries were not read (links or folders)");
  });

  it("a file from 7 days ago at 23:00 is not flagged a day early: the real time of the file counts", async () => {
    const r = run({
      config: cfg,
      env: {},
      files: { "backups/db": [file("latest.sql.gz", 10, "2026-11-04T23:00:00Z")] },
    });
    expect(await r.all()).toEqual([]);
    const late = run({
      config: cfg,
      env: {},
      files: { "backups/db": [file("latest.sql.gz", 10, "2026-11-04T08:00:00Z")] },
    });
    expect((await late.all()).map((f) => f.checkId)).toEqual(["no-recent-backup"]);
  });

  it("a partial Sanity read that looks stale is could-not-check, a fresh one is fine", async () => {
    const page1 = (created: string) => ({
      [`GET ${SANITY_URL}`]: {
        status: 200,
        body: { backups: [{ createdAt: created }], nextCursor: "c2" },
      },
      [`GET ${SANITY_URL}?nextCursor=c2`]: { status: 500 },
    });
    const stale = run({ routes: page1("2026-10-01T02:00:00Z") });
    expect(await stale.all()).toEqual([]);
    expect(stale.notes.map((n) => n.reason).join(" ")).toContain("may have missed");
    const fresh = run({ routes: page1("2026-11-10T02:00:00Z") });
    expect(await fresh.all()).toEqual([]);
  });

  it("no-recent-backup's done text does not claim a restore was tested", () => {
    expect(noRecentBackup.done).not.toMatch(/knows how to restore/);
  });
});
