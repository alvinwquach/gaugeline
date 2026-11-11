import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultSchema } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { folderLister } from "../export-folder.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";
import { runAll } from "../run-all.js";
import {
  BAR_CONFIG,
  BAR_ENV,
  NOW,
  SUPABASE_TOKEN,
  backupsWorld,
  barLister,
} from "./helpers/backups-world.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function folder(config?: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-backups-")));
  dirs.push(dir);
  if (config !== undefined)
    writeFileSync(join(dir, "gaugeline.backups.json"), JSON.stringify(config));
  return dir;
}

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined> = BAR_ENV,
  over: Parameters<typeof backupsWorld>[0] = {},
  lister: typeof barLister | undefined = barLister,
) {
  const w = backupsWorld(over);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env },
    {
      cwd,
      now: () => NOW,
      fetcher: { transport: w.transport },
      ...(lister ? { backups: { lister } } : {}),
    } as never,
  );
  return { code, out: out.join(""), err: err.join(""), seen: w.seen };
}

describe("gaugeline backups: end to end (recorded responses)", () => {
  it("prints each source, then the findings, and exits 0 without --ci", async () => {
    const r = await run(
      ["backups", "marlowe-bar.example", "--no-open", "--quiet"],
      folder(BAR_CONFIG),
    );
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.split("\n").slice(0, 4)).toEqual([
      "Backups for marlowe-bar.example",
      "  Supabase project abcdefghijklmnopqrst: daily backups on, point-in-time recovery off. Newest backup 12 days ago (30 Oct 2026), over the 7-day limit.",
      '  Export "menu" (backups/menu): 3 files, newest menu-2026-11-10.json.gz, 12 KB, dated 1 day ago (10 Nov 2026), the one before 94 KB (far smaller).',
      "",
    ]);
    expect(r.out).toContain("No recent backup");
    expect(r.out).toContain("The latest export is far smaller than the one before");
    expect(r.out).not.toContain(SUPABASE_TOKEN);
  });

  it("--ci exits 1 on the high-severity finding", async () => {
    const r = await run(
      ["backups", "marlowe-bar.example", "--ci", "--no-open", "--quiet"],
      folder(BAR_CONFIG),
    );
    expect(r.code).toBe(EXIT.findings);
  });

  it("only GETs are sent, the key is in a header and never in an address", async () => {
    const r = await run(
      ["backups", "marlowe-bar.example", "--no-open", "--quiet"],
      folder(BAR_CONFIG),
    );
    expect(new Set(r.seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    expect(r.seen.some((s) => s.url.includes(SUPABASE_TOKEN))).toBe(false);
    const api = r.seen.find((s) => s.url.startsWith("https://api.supabase.com"));
    expect(api?.headers.authorization).toBe(`Bearer ${SUPABASE_TOKEN}`);
  });

  it("a token that may not read backups is could-not-check, and the page checks still ran", async () => {
    const r = await run(
      ["backups", "marlowe-bar.example", "--no-open", "--quiet"],
      folder({ supabase: BAR_CONFIG.supabase }),
      BAR_ENV,
      { supabase: { status: 403 } },
    );
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Supabase: could not check: Supabase refused the token (HTTP 403)");
    expect(r.out).not.toContain(SUPABASE_TOKEN);
  });

  it("a site on a hosted builder gets a checklist line, and nothing is asked of any API", async () => {
    const r = await run(["backups", "ember-popup.example", "--no-open", "--quiet"], folder(), {
      NO_COLOR: "1",
    });
    expect(r.out).toContain("No backup source is set up, so no backup status was read.");
    expect(r.out).toContain("Check by hand");
    expect(r.out).toContain("[ ] Wix: Gaugeline cannot read Wix's backup status");
    expect(r.seen.some((s) => /supabase|sanity/.test(s.url))).toBe(false);
  });

  it("a settings file that is wrong is exit 2 before any request", async () => {
    const dir = folder({ supabase: { projectRef: "nope" } });
    const r = await run(["backups", "marlowe-bar.example", "--no-open", "--quiet"], dir);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("gaugeline.backups.json");
    expect(r.seen).toEqual([]);
  });
});

describe("the export folder on disk", () => {
  it("lists names, sizes and times without opening a file, and skips subfolders", async () => {
    const dir = folder();
    mkdirSync(join(dir, "dumps", "old"), { recursive: true });
    const f = join(dir, "dumps", "db-2026-11-10.sql");
    writeFileSync(f, "x".repeat(40));
    const when = new Date("2026-11-10T03:00:00Z");
    utimesSync(f, when, when);
    const listed = await folderLister(dir)("dumps");
    expect(listed).toEqual([
      { name: "db-2026-11-10.sql", size: 40, modified: "2026-11-10T03:00:00.000Z" },
    ]);
  });

  it("a missing folder is could-not-check with the reason, end to end", async () => {
    const r = await run(
      ["backups", "marlowe-bar.example", "--no-open", "--quiet"],
      folder({ exports: [{ name: "database", folder: "nowhere" }] }),
      { NO_COLOR: "1" },
      {},
      undefined,
    );
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain(
      'Export "database" (nowhere): could not check: the folder nowhere could not be read',
    );
  });
});

describe("the page check with --backups, and the nightly run", () => {
  it("adds the backups checks to the page check only when asked", async () => {
    const dir = folder(BAR_CONFIG);
    const ids = (text: string) =>
      resultSchema.parse(JSON.parse(text)).findings.map((f) => f.checkId);
    const without = await run(["marlowe-bar.example", "--json", "--no-open", "--quiet"], dir);
    expect(ids(without.out)).not.toContain("no-recent-backup");
    expect(without.seen.some((s) => s.url.includes("api.supabase.com"))).toBe(false);
    const withIt = await run(
      ["marlowe-bar.example", "--backups", "--json", "--no-open", "--quiet"],
      dir,
    );
    expect(ids(withIt.out)).toEqual(
      expect.arrayContaining(["no-recent-backup", "export-too-small"]),
    );
    expect(withIt.out).not.toContain("Backups for");
  });

  it("run --all --backups hands the flag to every site's run", async () => {
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
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, backups: true, runOne });
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, runOne });
    expect(seen[0]).toContain("--backups");
    expect(seen[1]).not.toContain("--backups");
  });

  it("parses --backups on the page check and on run, and the backups command", () => {
    const a = parseCliArgs(["marlowe-bar.example", "--backups"], {});
    expect(a.kind === "run" && a.backups).toBe(true);
    const b = parseCliArgs(["backups", "marlowe-bar.example"], {});
    expect(b.kind === "run" && b.backups && b.command).toBe("backups");
    const c = parseCliArgs(["run", "--all", "--backups"], {});
    expect(c.kind === "run-all" && c.backups).toBe(true);
    const d = parseCliArgs(["marlowe-bar.example"], {});
    expect(d.kind === "run" && d.backups).toBe(false);
    expect(parseCliArgs(["backups"], {}).kind).toBe("error");
  });
});

describe("the handoff checklist", () => {
  it("names systems whose backups cannot be read, and never Supabase or Sanity", async () => {
    const dir = folder();
    writeFileSync(
      join(dir, "gaugeline.handoff.json"),
      JSON.stringify({ clientEmails: [["owner", "ember-popup.example"].join("@")] }),
    );
    const r = await run(["handoff", "ember-popup.example", "--json", "--quiet"], dir, {
      NO_COLOR: "1",
    });
    const summary = JSON.parse(r.out) as { checklist: { system: string; text: string }[] };
    const lines = summary.checklist.filter((c) => c.system === "backups");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("Backups: Wix: Gaugeline cannot read Wix's backup status");
  });
});

describe("backups: help and flags", () => {
  it("has its own help, which lists the flags it accepts", () => {
    const help = HELP.backups ?? "";
    expect(help).toContain("gaugeline backups <address>");
    expect(help).toContain("--ci");
    expect(help).toContain("SUPABASE_ACCESS_TOKEN");
    expect(help).not.toContain("--dns");
  });

  it("--backups is on the page check and on run", () => {
    expect(FLAGS.find((f) => f.name === "backups")?.commands).toEqual(["check", "run"]);
    expect(HELP[""]).toContain("--backups");
  });
});
