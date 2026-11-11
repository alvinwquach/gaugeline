import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { resultSchema, type Transport } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../fixtures/src/index.js";
import { staticSite } from "../../../testkit/src/index.js";
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-trackers-")));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, "gaugeline.trackers.json"), config);
  return dir;
}

const HOST = "meadowlark.example";

async function run(argv: string[], cwd: string) {
  const seen: { method: string; url: string }[] = [];
  const others: Transport = (_url, req) =>
    Promise.resolve({
      status: 404,
      headers: { "content-type": "text/plain" },
      body: Readable.from(req.method === "HEAD" ? [] : [Buffer.from("not found")]),
    });
  const site = staticSite(HOST, join(SITES_DIR, "clinic-trackers"), others);
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    return site(url, req);
  };
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    { cwd, fetcher: { transport } } as never,
  );
  return { code, out: out.join(""), err: err.join(""), seen };
}

/** The tracker findings of a --json run (the page check's other findings are not what these tests are about). */
const trackerFindings = (text: string) =>
  resultSchema.parse(JSON.parse(text)).findings.filter((f) => f.checkId.startsWith("tracker-"));
const ids = (text: string) => trackerFindings(text).map((f) => f.checkId);

describe("gaugeline check --trackers: end to end (the invented clinic, in memory)", () => {
  it("lists the trackers on the intake page and none on the blog", async () => {
    const intake = await run([`${HOST}/intake`, "--trackers", "--no-open", "--quiet"], folder());
    expect(intake.code).toBe(EXIT.ok);
    expect(intake.out).toContain(
      "Meta pixel (id 123456789012345) loads on /intake, a page with a form that sends to intake.carelink-forms.example",
    );
    expect(intake.out).toContain("Hotjar session replay (id 3400001)");
    const blog = await run([`${HOST}/blog`, "--trackers", "--no-open", "--quiet"], folder());
    expect(blog.out).not.toContain("loads on /blog");
    expect(blog.out).not.toContain("Meta pixel");
  });

  it("is not in the run without --trackers", async () => {
    const r = await run([`${HOST}/intake`, "--json", "--no-open", "--quiet"], folder());
    expect(ids(r.out)).not.toContain("tracker-on-sensitive-page");
    expect(r.out).not.toContain("123456789012345");
  });

  it("--json carries the findings in schema 2, low severity, with no form field in it", async () => {
    const r = await run(
      [`${HOST}/intake`, "--trackers", "--json", "--no-open", "--quiet"],
      folder(),
    );
    expect(trackerFindings(r.out).map((f) => [f.checkId, f.severity])).toEqual([
      ["tracker-on-sensitive-page", "low"],
      ["tracker-on-sensitive-page", "low"],
      ["tracker-on-sensitive-page", "low"],
    ]);
    expect(r.out).not.toContain("date_of_birth");
  });

  it("gaugeline.trackers.json lists the pages that count without a form", async () => {
    const without = await run(
      [`${HOST}/conditions/asthma`, "--trackers", "--json", "--no-open", "--quiet"],
      folder(),
    );
    expect(ids(without.out)).toEqual([]);
    const listed = await run(
      [`${HOST}/conditions/asthma`, "--trackers", "--json", "--no-open", "--quiet"],
      folder('{"sensitivePaths":["/conditions/*"]}'),
    );
    expect(ids(listed.out)).toEqual(["tracker-on-sensitive-page"]);
  });

  it("a settings file that does not read is exit 2, naming the file", async () => {
    for (const bad of ['{"sensitivePaths":["conditions"]}', '{"paths":["/x"]}', "{not json"]) {
      const r = await run([`${HOST}/intake`, "--trackers", "--no-open"], folder(bad));
      expect(r.code, bad).toBe(EXIT.couldNotRun);
      expect(r.err).toContain("gaugeline.trackers.json");
    }
  });

  it("asks only GET or HEAD", async () => {
    const r = await run([`${HOST}/intake`, "--trackers", "--no-open", "--quiet"], folder());
    expect(r.seen.every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
  });
});

describe("--trackers: parsing, run --all, help and flags", () => {
  it("parses --trackers on the page check and on run, off by default", () => {
    const a = parseCliArgs(["meadowlark.example", "--trackers"], {});
    expect(a.kind === "run" && a.trackers).toBe(true);
    const b = parseCliArgs(["run", "--all", "--trackers"], {});
    expect(b.kind === "run-all" && b.trackers).toBe(true);
    const c = parseCliArgs(["meadowlark.example"], {});
    expect(c.kind === "run" && c.trackers).toBe(false);
  });

  it("run --all --trackers hands the flag to every site's run", async () => {
    const dir = folder();
    mkdirSync(join(dir, "runs"));
    const seen: string[][] = [];
    const site = {
      name: "meadowlark",
      address: "https://meadowlark.example",
      host: "meadowlark.example",
      configDir: dir,
      permission: { by: "Dr Imani Brooks, owner of Meadowlark Family Clinic", on: "2026-11-01" },
    };
    const runOne = async (argv: string[]) => {
      seen.push(argv);
      return 0;
    };
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, trackers: true, runOne });
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, runOne });
    expect(seen[0]).toContain("--trackers");
    expect(seen[1]).not.toContain("--trackers");
  });

  it("the flag is on the page check and on run, and in --help", () => {
    const flag = FLAGS.find((f) => f.name === "trackers");
    expect(flag?.commands).toEqual(["check", "run"]);
    expect(HELP[""]).toContain("--trackers");
  });
});
