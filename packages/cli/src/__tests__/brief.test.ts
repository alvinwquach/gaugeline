import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrief, createPageRegistry, parseResult, renderBriefMarkdown } from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { nodeFs, type ScaffoldFs } from "../scaffold-write.js";

const NOW = new Date("2026-11-10T09:00:00.000Z");
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A working folder at its real path (macOS's tmpdir is a link, and Windows may shorten it). */
function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-brief-")));
  made.push(dir);
  return dir;
}

const nowhere = async (): Promise<never> => {
  throw Object.assign(new Error("getaddrinfo ENOTFOUND (test)"), { code: "ENOTFOUND" });
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
      now: () => NOW,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function brief(fixture: string, flags: string[], cwd: string, fs?: ScaffoldFs) {
  const site = await startFixture(fixture);
  try {
    const run = capture();
    const code = await main(["brief", site.origin, "--allow-private", ...flags], run.io, {
      version: "0.2.0",
      cwd,
      now: () => NOW,
      fetcher: { hosts: site.hosts, resolver: nowhere },
      ...(fs ? { briefFs: fs } : {}),
    });
    return { code, out: run.out(), err: run.err(), origin: site.origin };
  } finally {
    await site.close();
  }
}

/** The same fixture checked the usual way, as --json, so the expected work order is made from a real result. */
async function resultOf(fixture: string, cwd: string) {
  const site = await startFixture(fixture);
  try {
    const run = capture();
    await main([site.origin, "--json", "--allow-private"], run.io, {
      version: "0.2.0",
      cwd,
      now: () => NOW,
      fetcher: { hosts: site.hosts, resolver: nowhere },
    });
    return parseResult(JSON.parse(run.out()));
  } finally {
    await site.close();
  }
}

const parsed = (argv: string[]) => parseCliArgs(argv);

describe("brief: arguments", () => {
  it("reads the address, the business, the rate (stored in minor units), the hours and the file", () => {
    const a = parsed([
      "brief",
      "cornerbar.test",
      "--business",
      "The Corner Bar",
      "--rate",
      "110",
      "--hours-per-point",
      "1.5",
      "--out",
      "work-order.md",
    ]);
    expect(a).toMatchObject({
      kind: "run",
      command: "brief",
      address: "https://cornerbar.test/",
      brief: {
        business: "The Corner Bar",
        rateMinor: 11000,
        hoursPerPoint: 1.5,
        out: "work-order.md",
        force: false,
      },
    });
  });

  it("every flag is optional", () => {
    const a = parsed(["brief", "cornerbar.test"]);
    expect(a).toMatchObject({ kind: "run", command: "brief", brief: { force: false } });
    expect((a as { brief: object }).brief).not.toHaveProperty("rateMinor");
    expect((a as { brief: object }).brief).not.toHaveProperty("out");
  });

  it("--rate is whole currency units: a fraction, a word, zero or a negative is refused", () => {
    for (const bad of ["110.50", "abc", "0", "-5", "1e3", "", "$110"]) {
      const a = parsed(["brief", "cornerbar.test", "--rate", bad]);
      expect(a.kind, bad).toBe("error");
      if (a.kind === "error") expect(a.message, bad).toMatch(/--rate/);
    }
  });

  it("--hours-per-point is a positive number with at most two decimals", () => {
    for (const bad of ["0", "abc", "-1", "1.234", "1,5", ""]) {
      const a = parsed(["brief", "cornerbar.test", "--hours-per-point", bad]);
      expect(a.kind, bad).toBe("error");
      if (a.kind === "error") expect(a.message, bad).toMatch(/--hours-per-point/);
    }
    for (const good of ["1", "1.5", "0.25", "2.00", "12"])
      expect(parsed(["brief", "cornerbar.test", "--hours-per-point", good]).kind, good).toBe("run");
  });

  it("--business and --out need a value, and --force only means something with --out", () => {
    for (const flag of ["--business", "--out"]) {
      const a = parsed(["brief", "cornerbar.test", flag, "  "]);
      expect(a.kind, flag).toBe("error");
    }
    const f = parsed(["brief", "cornerbar.test", "--force"]);
    expect(f.kind).toBe("error");
    if (f.kind === "error") expect(f.message).toMatch(/--force.*--out/);
    expect(parsed(["brief", "cornerbar.test", "--out", "w.md", "--force"])).toMatchObject({
      kind: "run",
      brief: { out: "w.md", force: true },
    });
  });

  it("needs exactly one address, and says how to run it", () => {
    for (const argv of [["brief"], ["brief", "a.test", "b.test"]]) {
      const a = parsed(argv);
      expect(a.kind).toBe("error");
      if (a.kind === "error") expect(a.message + (a.hint ?? "")).toMatch(/gaugeline brief|address/);
    }
  });

  it("the flags belong to brief: the page check does not take them", () => {
    for (const flag of ["--business", "--rate", "--hours-per-point"]) {
      const a = parsed(["cornerbar.test", flag, "1"]);
      expect(a.kind, flag).toBe("error");
    }
  });

  it("--help is its own text and names every flag the command takes", () => {
    expect(parsed(["brief", "--help"])).toMatchObject({ kind: "help", command: "brief" });
    const help = HELP.brief ?? "";
    for (const flag of ["--business", "--rate", "--hours-per-point", "--out", "--force"])
      expect(help, flag).toContain(flag);
    expect(help).toMatch(/Usage: gaugeline brief <address>/);
  });
});

/**
 * The work order the command wrote before G28a split it into buildBrief and renderBriefMarkdown,
 * kept as files made by that version (the fixture's own address swapped for ORIGIN). The split must
 * not change one character of it.
 */
describe("brief: output is unchanged by the formatter split (G28a)", () => {
  const golden = (name: string): string =>
    fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));
  /** Line ends as LF, and the fixture's mail address as ADDRESS (the repository keeps no address in a file). */
  const plain = (text: string, origin: string): string =>
    text
      .replaceAll("\r\n", "\n")
      .replaceAll(origin, "ORIGIN")
      .replaceAll(/[\w.+-]+@[\w.-]+/g, "ADDRESS");

  it("with a business, an hours-per-point and a rate, byte for byte", async () => {
    const r = await brief(
      "corner-bar",
      ["--business", "The Corner Bar", "--rate", "110", "--hours-per-point", "1.5"],
      folder(),
    );
    expect(r.code).toBe(0);
    await expect(plain(r.out, r.origin)).toMatchFileSnapshot(golden("brief-corner-bar-priced.md"));
  });

  it("with points only and the host as the name, byte for byte", async () => {
    const r = await brief("corner-bar", [], folder());
    expect(r.code).toBe(0);
    await expect(plain(r.out, r.origin)).toMatchFileSnapshot(golden("brief-corner-bar-points.md"));
  });
});

describe("brief: e2e (CLI against the Corner Bar fixture)", () => {
  it("prints the work order on stdout when there is no --out, and writes no file", async () => {
    const cwd = folder();
    const r = await brief("corner-bar", ["--business", "The Corner Bar"], cwd);
    expect(r.code).toBe(0);
    const first = r.out.split(/\r?\n/)[0];
    expect(first).toBe("# Work order: The Corner Bar");
    // Nothing else is written: no report file, no state.
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("is the same text the core function makes from the same result", async () => {
    const cwd = folder();
    const expected = renderBriefMarkdown(
      buildBrief(await resultOf("corner-bar", cwd), createPageRegistry(), {
        business: "The Corner Bar",
        hoursPerPoint: 1.5,
        rateMinor: 11000,
      }),
    );
    const r = await brief(
      "corner-bar",
      ["--business", "The Corner Bar", "--rate", "110", "--hours-per-point", "1.5"],
      cwd,
    );
    // The address in the heading line is the fixture's own: swap it for the one the other run had.
    expect(r.out.replaceAll(r.origin, "ORIGIN")).toBe(
      expected.replaceAll(/http:\/\/127\.0\.0\.1:\d+/g, "ORIGIN"),
    );
  });

  it("lists items by severity then size, each with the five parts", async () => {
    const r = await brief("corner-bar", [], folder());
    const headings = r.out.split(/\r?\n/).filter((l) => /^## \d+\. /.test(l));
    expect(headings.length).toBeGreaterThan(2);
    for (const label of [
      "**What is wrong:**",
      "**Why it matters:**",
      "**What done looks like:**",
      "**Evidence:**",
      "**What changes the estimate:**",
    ])
      expect(r.out).toContain(label);
    expect(r.out).toMatch(/\d+ items are worth paying to fix, \d+ points in all/);
    // Points only without --hours-per-point.
    expect(r.out).not.toMatch(/hours/);
  });

  it("with a rate and no hours-per-point prints points only and says why on stderr", async () => {
    const r = await brief("corner-bar", ["--rate", "110"], folder());
    expect(r.out).not.toMatch(/hours|\$/);
    expect(r.err).toMatch(/--rate is used only with --hours-per-point/);
    const quiet = await brief("corner-bar", ["--rate", "110", "--quiet"], folder());
    expect(quiet.err).not.toMatch(/--rate is used only/);
  });

  it("with hours-per-point and a rate prints a range, never a single number", async () => {
    const r = await brief("corner-bar", ["--hours-per-point", "1.5", "--rate", "110"], folder());
    expect(r.out).toMatch(
      /At 1\.5 hours per point, that's roughly \d+\u2013\d+ hours \(about \$[\d,]+\u2013\$[\d,]+ at \$110\/hour\)\./,
    );
  });

  it("says nothing needs paying for on a clean site, and exits 0", async () => {
    const r = await brief("clean", ["--business", "Fixture Bakery"], folder());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Nothing needs paying for/);
  });

  it("exits 0 when the site has findings that need fixing first: it writes a work order, not a verdict", async () => {
    const r = await brief("corner-bar", [], folder());
    expect(r.out).toMatch(/Fix this first/);
    expect(r.code).toBe(0);
  });

  it("--out writes the file inside the working folder and says where", async () => {
    const cwd = folder();
    const r = await brief("corner-bar", ["--out", "work-order.md"], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/Work order written to work-order\.md/);
    const file = readFileSync(join(cwd, "work-order.md"), "utf8");
    expect(file.split(/\r?\n/)[0]).toBe(`# Work order: ${new URL(r.origin).hostname}`);
    expect(readdirSync(cwd)).toEqual(["work-order.md"]);
  });

  it("--out into a folder that does not exist yet makes the folder", async () => {
    const cwd = folder();
    const r = await brief("corner-bar", ["--out", join("quotes", "bar.md")], cwd);
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, "quotes", "bar.md"))).toBe(true);
  });

  it("never overwrites a file that is there without --force, and the file is left as it was", async () => {
    const cwd = folder();
    writeFileSync(join(cwd, "work-order.md"), "mine\n");
    const r = await brief("corner-bar", ["--out", "work-order.md"], cwd);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/already exists, so nothing was written/);
    expect(r.err).toMatch(/--force/);
    expect(readFileSync(join(cwd, "work-order.md"), "utf8")).toBe("mine\n");
    const forced = await brief("corner-bar", ["--out", "work-order.md", "--force"], cwd);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(cwd, "work-order.md"), "utf8")).toMatch(/^# Work order/);
  });

  it("refuses a file outside the working folder, and one reached through a link, before writing", async () => {
    const cwd = folder();
    const elsewhere = folder();
    const r = await brief("corner-bar", ["--out", join("..", basename(elsewhere), "w.md")], cwd);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/is not a file inside the folder you ran the command in/);
    expect(readdirSync(elsewhere)).toEqual([]);
    let linked = false;
    try {
      symlinkSync(elsewhere, join(cwd, "out"), "junction");
      linked = true;
    } catch {
      // A platform that does not let this account make a link: the check above covers the rest.
    }
    if (linked) {
      const through = await brief("corner-bar", ["--out", join("out", "w.md")], cwd);
      expect(through.code).toBe(2);
      expect(readdirSync(elsewhere)).toEqual([]);
    }
  });

  it("refuses an absolute path outside the folder", async () => {
    const cwd = folder();
    const elsewhere = folder();
    const r = await brief("corner-bar", ["--out", join(elsewhere, "w.md")], cwd);
    expect(r.code).toBe(2);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("goes through the safe writer: a write that fails leaves the folder as it was found", async () => {
    const cwd = folder();
    mkdirSync(join(cwd, "keep"));
    const failing: ScaffoldFs = {
      ...nodeFs,
      writeFile: async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    const r = await brief("corner-bar", ["--out", join("new-folder", "w.md")], cwd, failing);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Nothing was written/);
    expect(readdirSync(cwd).sort()).toEqual(["keep"]);
  });

  it("the work order shows no key, and only the evidence the report shows", async () => {
    const cwd = folder();
    const r = await brief("corner-bar", [], cwd);
    expect(r.out).not.toMatch(/(sk|pk|rk)_(live|test)_/);
    // Markup from the page is escaped, never live.
    expect(r.out).not.toMatch(/(?<!\\)<(script|img|meta|link)/);
  });
});
