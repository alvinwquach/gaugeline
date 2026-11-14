import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyProposal,
  checkRedirects,
  createFetcher,
  parseProposalFile,
  readPlan,
} from "@gaugeline/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { preview } from "./helpers/redirect-preview.js";

const FIX = fileURLToPath(new URL("../../../fixtures/fix-proposals/", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-propose-")));
  cpSync(FIX, dir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function propose(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["propose", ...argv],
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    { cwd: dir },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline propose: the command line", () => {
  it("is off by default: exit 2 with the way to turn it on, and nothing written", async () => {
    const r = await propose([
      "--repo",
      "lantern-books",
      "--plan",
      "lantern-books/plan.csv",
      "--base",
      "http://127.0.0.1:1",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/off by default/);
    expect(r.err).toMatch(/--fixes/);
  });
  it("GAUGELINE_FIXES=1 turns it on, like --fixes", () => {
    const parsed = parseCliArgs(["propose", "run.json", "--repo", "."], { GAUGELINE_FIXES: "1" });
    expect(parsed).toMatchObject({
      kind: "propose",
      fixes: true,
      run: "run.json",
      out: "gaugeline.proposals.json",
    });
    expect(parseCliArgs(["propose", "run.json", "--repo", "."], {})).toMatchObject({
      fixes: false,
    });
  });
  it("refuses what it cannot run: no folder, a plan without a preview, nothing to answer, a bad repository name", () => {
    const kinds = [
      ["propose", "run.json"],
      ["propose", "--repo", ".", "--plan", "p.csv"],
      ["propose", "--repo", "."],
      ["propose", "run.json", "--repo", ".", "--repository", "not a name"],
      ["propose", "a.json", "b.json", "--repo", "."],
    ].map((a) => parseCliArgs(a, {}).kind);
    expect(kinds).toEqual(["error", "error", "error", "error", "error"]);
  });
  it("every flag of the command is in --help", () => {
    for (const f of flagsFor(FLAGS, "propose")) expect(HELP.propose).toContain(`--${f.name}`);
  });
});

describe("gaugeline propose: a missing redirect becomes a proposal that fixes it", () => {
  it("end to end on the fixture project: propose, apply the diff to a copy, check again", async () => {
    const root = join(dir, "lantern-books");
    const site = await preview(join(dir, "lantern-books/public/_redirects"));
    try {
      const plan = readPlan(readFileSync(join(root, "plan.csv")));
      // A new fetcher for each look: the fetcher keeps what it has already been told.
      const look = () => createFetcher({ allowPrivate: true });
      const before = await checkRedirects(plan.rows, { base: site.origin, fetcher: look() });
      expect(before.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        ["plan-redirect-missing", "/old-poetry returns 404: nothing redirects it"],
        ["plan-redirect-missing", "/old-kids returns 404: nothing redirects it"],
      ]);

      const r = await propose([
        "--fixes",
        "--repo",
        "lantern-books",
        "--repository",
        "studio/lantern-books",
        "--plan",
        "lantern-books/plan.csv",
        "--base",
        site.origin,
        "--allow-private",
        "--out",
        "proposals.json",
      ]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("+/old-poetry\t/poetry\t301");
      expect(r.out).toContain("2 proposals written to proposals.json. Nothing was sent anywhere.");
      const file = parseProposalFile(JSON.parse(readFileSync(join(dir, "proposals.json"), "utf8")));
      expect(file.proposals.map((p) => p.summary)).toEqual([
        "Redirect /old-poetry to /poetry",
        "Redirect /old-kids to /kids",
      ]);
      expect(file.proposals[0]?.target).toEqual({
        repository: "studio/lantern-books",
        path: "public/_redirects",
      });
      // The project itself is untouched by propose.
      expect(readFileSync(join(root, "public/_redirects"), "utf8")).not.toContain("old-poetry");

      // The two proposals both add to the same file: apply the first to a copy, then the second is
      // made again from the changed file (what a person does one pull request at a time).
      const redirects = join(root, "public/_redirects");
      const first = file.proposals[0];
      expect(first).toBeDefined();
      if (!first) return;
      const changed = applyProposal(readFileSync(redirects, "utf8"), first);
      expect(changed).toBeDefined();
      writeFileSync(redirects, changed ?? "");
      const mid = await checkRedirects(plan.rows, { base: site.origin, fetcher: look() });
      expect(mid.findings.map((f) => f.evidence)).toEqual([
        "/old-kids returns 404: nothing redirects it",
      ]);

      const again = await propose([
        "--fixes",
        "--repo",
        "lantern-books",
        "--plan",
        "lantern-books/plan.csv",
        "--base",
        site.origin,
        "--allow-private",
        "--out",
        "second.json",
      ]);
      const second = parseProposalFile(JSON.parse(readFileSync(join(dir, "second.json"), "utf8")));
      expect(second.proposals).toHaveLength(1);
      expect(again.out).toContain("+/old-kids\t/kids\t301");
      writeFileSync(redirects, applyProposal(changed ?? "", second.proposals[0] ?? first) ?? "");
      const after = await checkRedirects(plan.rows, { base: site.origin, fetcher: look() });
      expect(after.findings).toEqual([]);
      // Only reads: the preview saw GET requests and nothing else.
      expect([...site.methods]).toEqual(["GET"]);
    } finally {
      await site.close();
    }
  });

  it("the same proposal made twice has the same id and diff, and a diff applied twice is refused", async () => {
    const site = await preview(join(dir, "lantern-books/public/_redirects"));
    try {
      const args = [
        "--fixes",
        "--repo",
        "lantern-books",
        "--plan",
        "lantern-books/plan.csv",
        "--base",
        site.origin,
        "--allow-private",
      ];
      await propose([...args, "--out", "one.json"]);
      await propose([...args, "--out", "two.json"]);
      const one = readFileSync(join(dir, "one.json"), "utf8");
      expect(readFileSync(join(dir, "two.json"), "utf8")).toBe(one);
      const p = parseProposalFile(JSON.parse(one)).proposals[0];
      const text = readFileSync(join(dir, "lantern-books/public/_redirects"), "utf8");
      const applied = p ? applyProposal(text, p) : undefined;
      expect(applied).toBeDefined();
      expect(p ? applyProposal(applied ?? "", p) : "x").toBeUndefined();
    } finally {
      await site.close();
    }
  });

  it("a hand-reformatted redirect file (comments, blank lines, CRLF, no final newline) still gets one added rule", async () => {
    writeFileSync(
      join(dir, "lantern-books/public/_redirects"),
      "# moved\r\n\r\n/old-fiction   /fiction   301!\r\n\r\n# kids\r\n/old-kids /kids",
    );
    const site = await preview(join(dir, "lantern-books/public/_redirects"));
    try {
      const r = await propose([
        "--fixes",
        "--repo",
        "lantern-books",
        "--plan",
        "lantern-books/plan.csv",
        "--base",
        site.origin,
        "--allow-private",
        "--out",
        "p.json",
      ]);
      expect(r.code).toBe(0);
      const p = parseProposalFile(JSON.parse(readFileSync(join(dir, "p.json"), "utf8"))).proposals;
      expect(p).toHaveLength(1);
      expect(p[0]?.change.diff).toContain("+/old-poetry /poetry 301");
    } finally {
      await site.close();
    }
  });

  it("when the fixer is not certain it says why, writes nothing and exits 0", async () => {
    writeFileSync(join(dir, "lantern-books/public/_redirects"), "/old-*  /archive/:splat  301\n");
    const site = await preview(join(dir, "lantern-books/public/_redirects"));
    try {
      const r = await propose([
        "--fixes",
        "--repo",
        "lantern-books",
        "--plan",
        "lantern-books/plan.csv",
        "--base",
        site.origin,
        "--allow-private",
        "--out",
        "none.json",
      ]);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/No proposal for plan-redirect-missing \(\/old-poetry\): .*pattern/);
      expect(r.out).toContain("No proposals: nothing was written and nothing was sent.");
      expect(() => readFileSync(join(dir, "none.json"))).toThrow();
    } finally {
      await site.close();
    }
  });
});

describe("gaugeline propose: a structured-data value that disagrees with the page", () => {
  it("proposes the one corrected line from a saved run", async () => {
    const r = await propose([
      "cedar-bar-run.json",
      "--fixes",
      "--repo",
      "cedar-bar",
      "--out",
      "ld.json",
    ]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain('-        "telephone": "+1 555 0100"');
    expect(r.out).toContain('+        "telephone": "+1 555 0142"');
    const p = parseProposalFile(JSON.parse(readFileSync(join(dir, "ld.json"), "utf8")))
      .proposals[0];
    expect(p).toMatchObject({
      fixer: "structured-data",
      target: { repository: null, path: "src/layout.html" },
    });
    const html = readFileSync(join(dir, "cedar-bar/src/layout.html"), "utf8");
    expect(p ? applyProposal(html, p) : "").toBe(html.replace("+1 555 0100", "+1 555 0142"));
  });
  it("a file that is not a saved run is exit 2", async () => {
    const r = await propose(["cedar-bar/vercel.json", "--fixes", "--repo", "cedar-bar"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not a saved Gaugeline run/);
  });
});

describe("gaugeline propose: the speed causes (PERF-04)", () => {
  const run = [
    "quillfeather-bakery-run.json",
    "--fixes",
    "--repo",
    "quillfeather-bakery",
    "--out",
    "perf.json",
  ];

  it("proposes the one certain change, the first large image's two attributes, and says why for the rest", async () => {
    const before = readFileSync(join(dir, "quillfeather-bakery/src/index.html"), "utf8");
    const r = await propose(run);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      '-      <img src="/img/loaves.jpg?w=3840" width="800" height="450" loading="lazy" alt="A tray of loaves">',
    );
    expect(r.out).toContain(
      '+      <img src="/img/loaves.jpg?w=3840" width="800" height="450" alt="A tray of loaves" fetchpriority="high">',
    );
    expect(r.out).toContain("1 proposal written to perf.json. Nothing was sent anywhere.");
    // The oversized width, the 3D scene and the missing fallback are left to a person, each with its reason.
    expect(r.err).toMatch(
      /No proposal for perf-lcp-image .*asked for at 3840 pixels.*left to a person/,
    );
    expect(r.err).toMatch(/No proposal for perf-webgl-autostart .*still picture/);
    expect(r.err).toMatch(/No proposal for perf-no-lowend-fallback .*saveData/);
    const p = parseProposalFile(JSON.parse(readFileSync(join(dir, "perf.json"), "utf8")))
      .proposals[0];
    expect(p).toMatchObject({ fixer: "performance", target: { path: "src/index.html" } });
    expect(p ? applyProposal(before, p) : "").toBe(
      before
        .replace(' loading="lazy"', "")
        .replace('alt="A tray of loaves">', 'alt="A tray of loaves" fetchpriority="high">'),
    );
    // The project is not touched.
    expect(readFileSync(join(dir, "quillfeather-bakery/src/index.html"), "utf8")).toBe(before);
  });

  it("--quiet hides the reasons, and the proposal is the same every time", async () => {
    const a = await propose([...run, "--quiet"]);
    expect(a.err).toBe("");
    const b = await propose([...run, "--quiet"]);
    expect(b.out).toBe(a.out);
  });

  it("makes no request: nothing is asked of any site", async () => {
    const asked: string[] = [];
    const out: string[] = [];
    await main(
      ["propose", ...run],
      {
        stdout: { write: (x: string) => out.push(x) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      },
      {
        cwd: dir,
        fetcher: {
          transport: (url: URL) => (asked.push(url.href), Promise.reject(new Error("no"))),
        } as never,
      },
    );
    expect(asked).toEqual([]);
  });

  it("a hand-edited proposal (the diff or the id changed) is refused when read back", async () => {
    await propose(run);
    const file = JSON.parse(readFileSync(join(dir, "perf.json"), "utf8"));
    file.proposals[0].change.diff = file.proposals[0].change.diff.replace(
      "fetchpriority",
      "fetchpriorities",
    );
    expect(() => parseProposalFile(file)).toThrow(/does not match its own content/);
  });
});
