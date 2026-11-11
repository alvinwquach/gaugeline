import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-libraries-")));
  dirs.push(dir);
  return dir;
}

const HOST = "corner-pantry.example";

async function run(argv: string[], cwd: string) {
  const seen: { method: string; url: string }[] = [];
  const others: Transport = (_url, req) =>
    Promise.resolve({
      status: 404,
      headers: { "content-type": "text/plain" },
      body: Readable.from(req.method === "HEAD" ? [] : [Buffer.from("not found")]),
    });
  const site = staticSite(HOST, join(SITES_DIR, "old-theme-shop"), others);
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

/** The library finding of a --json run (the page check's other findings are not what these tests are about). */
const libraryResult = (text: string) => {
  const result = resultSchema.parse(JSON.parse(text));
  return {
    findings: result.findings.filter((f) => f.checkId === "library-with-advisory"),
    couldNotCheck: result.couldNotCheck.filter((c) => c.id === "library-with-advisory"),
  };
};

describe("gaugeline check --libraries: end to end (the invented shop, in memory)", () => {
  it("names the jQuery on the old theme, its advisories and their fixes", async () => {
    const r = await run([HOST, "--libraries", "--no-open", "--quiet"], folder());
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain(
      "jQuery 1.12.4 is served from https://corner-pantry.example/assets/js/jquery.min.js (version read from the file's banner comment). 4 advisories in Gaugeline's list name versions that include it: CVE-2020-11023",
    );
    expect(r.out).toContain("fixed in 3.5.0");
    expect(r.out).not.toContain("Moment.js 2.29.4");
    expect(r.out).not.toContain("Lodash 4.17.21");
  });

  it("--json carries one medium finding, and the two could-not-check lines", async () => {
    const r = await run([HOST, "--libraries", "--json", "--no-open", "--quiet"], folder());
    const got = libraryResult(r.out);
    expect(got.findings.map((f) => f.severity)).toEqual(["medium"]);
    expect(got.couldNotCheck).toHaveLength(2);
    expect(got.couldNotCheck[0]?.reason).toContain("Bootstrap is served from");
    expect(got.couldNotCheck[1]?.reason).toContain("theme.min.js");
    expect(r.out).not.toContain("pantryOpens");
  });

  it("a medium finding is not a reason to fail a --ci run", async () => {
    const r = await run([HOST, "--libraries", "--ci", "--no-open", "--quiet"], folder());
    expect(r.code).toBe(EXIT.ok);
  });

  it("is not in the run without --libraries: no finding and no could-not-check line", async () => {
    const r = await run([HOST, "--json", "--no-open", "--quiet"], folder());
    expect(libraryResult(r.out)).toEqual({ findings: [], couldNotCheck: [] });
  });

  it("asks only GET or HEAD, and only for the scripts the page names", async () => {
    const r = await run([HOST, "--libraries", "--no-open", "--quiet"], folder());
    expect(r.seen.every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
    const js = r.seen
      .filter((s) => s.url.endsWith(".js"))
      .map((s) => s.url.replace(`https://${HOST}`, ""));
    expect(js.sort()).toEqual(
      ["bootstrap", "jquery", "lodash", "moment", "theme"].map((n) => `/assets/js/${n}.min.js`),
    );
  });
});

describe("--libraries: parsing, run --all, help and flags", () => {
  it("parses --libraries on the page check and on run, off by default", () => {
    const a = parseCliArgs([HOST, "--libraries"], {});
    expect(a.kind === "run" && a.libraries).toBe(true);
    const b = parseCliArgs(["run", "--all", "--libraries"], {});
    expect(b.kind === "run-all" && b.libraries).toBe(true);
    const c = parseCliArgs([HOST], {});
    expect(c.kind === "run" && c.libraries).toBe(false);
  });

  it("run --all --libraries hands the flag to every site's run", async () => {
    const dir = folder();
    mkdirSync(join(dir, "runs"));
    const seen: string[][] = [];
    const site = {
      name: "pantry",
      address: `https://${HOST}`,
      host: HOST,
      configDir: dir,
      permission: { by: "Mo Okafor, owner of Corner Pantry", on: "2026-11-01" },
    };
    const runOne = async (argv: string[]) => {
      seen.push(argv);
      return 0;
    };
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, libraries: true, runOne });
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, runOne });
    expect(seen[0]).toContain("--libraries");
    expect(seen[1]).not.toContain("--libraries");
  });

  it("the flag is on the page check and on run, and in --help", () => {
    const flag = FLAGS.find((f) => f.name === "libraries");
    expect(flag?.commands).toEqual(["check", "run"]);
    expect(HELP[""]).toContain("--libraries");
  });
});
