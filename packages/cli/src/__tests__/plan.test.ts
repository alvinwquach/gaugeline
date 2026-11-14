import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-plan-"));
  dirs.push(dir);
  for (const f of ["keyword-map.csv", "workbook-export.txt", "legacy-notes.csv"])
    cpSync(join(SITES_DIR, "..", "plans", f), join(dir, f));
  return dir;
}

describe("gaugeline plan: e2e (CLI)", () => {
  it("reads the keyword map and prints the plan check page's Output block", async () => {
    const run = capture();
    const code = await main(["plan", "keyword-map.csv"], run.io, { cwd: workdir() });
    // Two duplicate-address groups: any plan finding exits 1, so it can gate a launch.
    expect(code).toBe(1);
    expect(withoutPassed(run.out()).trimEnd()).toBe(expectedOutput("plan-check", "Example"));
  });

  it("--plan-only is accepted and makes no request", async () => {
    const run = capture();
    expect(await main(["plan", "keyword-map.csv", "--plan-only"], run.io, { cwd: workdir() })).toBe(
      1,
    );
    expect(run.out()).toContain("Read 163 pages");
  });

  it("no URL column: exit 2 with the headers found; a missing file or no file: exit 2", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "bad.csv"), "Page,Title Tag\nHome,Welcome\n");
    let run = capture();
    expect(await main(["plan", "bad.csv"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("The plan has no URL column. Headers found: Page, Title Tag.");
    run = capture();
    expect(await main(["plan", "nope.csv"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("nope.csv could not be read.");
    run = capture();
    expect(await main(["plan"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("gaugeline plan needs one plan file");
  });

  it("two URL columns: the first is used and the warning is printed", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "two.csv"), "URL,Address\n/a,/b\n");
    const run = capture();
    expect(await main(["plan", "two.csv"], run.io, { cwd: dir })).toBe(0);
    expect(run.out()).toContain(
      '! Columns "URL" and "Address" both look like the URL column; using "URL".',
    );
  });

  it("a workbook export: one line on stderr says which tab was read", async () => {
    const run = capture();
    expect(
      await main(["plan", "workbook-export.txt", "--plan-only"], run.io, { cwd: workdir() }),
    ).toBe(1);
    expect(run.err()).toBe("Read tab: Kim's Keywords (6 other tabs skipped)\n");
    expect(run.out()).toContain("/software/ai-automation on 3 rows\n    lines 147, 148, 149");
    expect(run.out()).toContain(
      "Read 163 pages from workbook-export.txt (4 rows without a URL skipped).",
    );
  });

  it("--sheet Footer: exit 2 naming the headers it found", async () => {
    const run = capture();
    expect(
      await main(["plan", "workbook-export.txt", "--sheet", "Footer", "--plan-only"], run.io, {
        cwd: workdir(),
      }),
    ).toBe(2);
    expect(run.err()).toContain(
      'The "Footer" tab has no URL column. Headers found: Main category, Link, Phase.',
    );
  });

  it("an .xls file: exit 2 saying to save it as .xlsx or CSV", async () => {
    const dir = workdir();
    writeFileSync(
      join(dir, "old.xls"),
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    );
    const run = capture();
    expect(await main(["plan", "old.xls"], run.io, { cwd: dir })).toBe(2);
    expect(run.err().split("\n")[0]).toBe(
      "old.xls is an .xls workbook (the old Excel format) or a password-protected one: save it as .xlsx without a password, or as CSV.",
    );
    expect(run.err()).not.toMatch(/\bat \S+:\d+/);
  });

  it("--legacy-from with --legacy-review: the CSV has one row per line of the printed table", async () => {
    const dir = workdir();
    const run = capture();
    const code = await main(
      [
        "plan",
        "legacy-notes.csv",
        "--plan-only",
        "--legacy-from",
        "SEO Notes",
        "--legacy-review",
        "out.csv",
      ],
      run.io,
      { cwd: dir },
    );
    expect(code).toBe(1);
    expect(withoutPassed(run.out()).trimEnd()).toBe(
      expectedOutput("plan-check", "Old addresses in a notes column"),
    );
    const tableRows = run
      .out()
      .split("\n")
      .filter((l) => /^ +\d+ {2}[a-z-]+ /.test(l));
    const csvRows = readFileSync(join(dir, "out.csv"), "utf8").trimEnd().split("\n").slice(1);
    expect(csvRows).toHaveLength(tableRows.length);
    expect(tableRows).toHaveLength(10);
    expect(run.err()).toBe(
      "Review table written to out.csv\nKeyword checks skipped: the plan has no Primary Keyword column.\n",
    );
  });

  it("without --legacy-from: nothing is read, and one hint names the column", async () => {
    const run = capture();
    await main(["plan", "legacy-notes.csv"], run.io, { cwd: workdir() });
    expect(run.err()).toBe(
      '"SEO Notes" mentions "legacy" in 10 rows: add --legacy-from "SEO Notes" to read old addresses from it.\n' +
        "Keyword checks skipped: the plan has no Primary Keyword column.\n",
    );
    expect(run.out()).not.toContain("Old addresses read");
  });

  it("a Legacy URL column and --legacy-from, an unknown column, or --legacy-review alone: exit 2", async () => {
    const dir = workdir();
    let run = capture();
    expect(
      await main(["plan", "keyword-map.csv", "--legacy-from", "Notes"], run.io, { cwd: dir }),
    ).toBe(2);
    expect(run.err()).toContain(
      'The plan has a Legacy URL column ("Legacy URL") and --legacy-from "Notes"',
    );
    run = capture();
    expect(
      await main(["plan", "legacy-notes.csv", "--legacy-from", "Comments"], run.io, { cwd: dir }),
    ).toBe(2);
    expect(run.err()).toContain(
      '--legacy-from: there is no column named "Comments". Headers: Page, URL, H1, SEO Notes.',
    );
    run = capture();
    expect(
      await main(["plan", "legacy-notes.csv", "--legacy-review", "x.csv"], run.io, { cwd: dir }),
    ).toBe(2);
    expect(run.err()).toContain("--legacy-review needs --legacy-from");
  });

  it("keyword checks: cannibalisation and overlap on the keywords plan, sorted by volume", async () => {
    const dir = workdir();
    cpSync(join(SITES_DIR, "..", "plans", "keywords.csv"), join(dir, "keywords.csv"));
    const run = capture();
    expect(await main(["plan", "keywords.csv", "--plan-only"], run.io, { cwd: dir })).toBe(1);
    expect(withoutPassed(run.out()).trimEnd()).toBe(expectedOutput("plan-check", "Keywords"));
  });

  it("--annotate writes <plan>.gaugeline.csv, keeps the exit code, and a second run needs --force", async () => {
    const dir = workdir();
    const before = {
      bytes: readFileSync(join(dir, "workbook-export.txt")),
      mtime: statSync(join(dir, "workbook-export.txt")).mtimeMs,
    };
    let run = capture();
    expect(
      await main(["plan", "workbook-export.txt", "--plan-only", "--annotate"], run.io, {
        cwd: dir,
      }),
    ).toBe(1);
    const out = join(dir, "workbook-export.gaugeline.csv");
    expect(run.err().split("\n")[0]).toBe(
      "Read tab: Kim's Keywords (6 other tabs skipped; the annotated copy has this tab only)",
    );
    expect(run.err()).toContain(`Annotated copy written to ${out}\n`);
    const written = readFileSync(out, "utf8");
    expect(written.split("\n")[0]?.endsWith(",Gaugeline")).toBe(true);
    run = capture();
    expect(
      await main(["plan", "workbook-export.txt", "--plan-only", "--annotate"], run.io, {
        cwd: dir,
      }),
    ).toBe(2);
    expect(run.err()).toContain("already exists: add --force to replace it.");
    expect(readFileSync(out, "utf8")).toBe(written);
    run = capture();
    expect(
      await main(["plan", "workbook-export.txt", "--annotate", "--force"], run.io, { cwd: dir }),
    ).toBe(1);
    // The plan itself is never touched.
    expect(readFileSync(join(dir, "workbook-export.txt")).equals(before.bytes)).toBe(true);
    expect(statSync(join(dir, "workbook-export.txt")).mtimeMs).toBe(before.mtime);
  });

  it("--annotate with a name, never over the plan; a folder it can't write to is exit 2 with the path", async () => {
    const dir = workdir();
    let run = capture();
    expect(
      await main(["plan", "keyword-map.csv", "--annotate", "notes.csv"], run.io, { cwd: dir }),
    ).toBe(1);
    expect(existsSync(join(dir, "notes.csv"))).toBe(true);
    run = capture();
    expect(
      await main(["plan", "keyword-map.csv", "--annotate", "keyword-map.csv", "--force"], run.io, {
        cwd: dir,
      }),
    ).toBe(2);
    expect(run.err()).toContain("--annotate would write over the plan itself (keyword-map.csv).");
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = join(dir, "locked");
      cpSync(join(dir, "keyword-map.csv"), join(dir, "copy.csv"));
      rmSync(locked, { recursive: true, force: true });
      writeFileSync(join(dir, "placeholder"), "");
      chmodSync(dir, 0o555);
      run = capture();
      try {
        expect(await main(["plan", "copy.csv", "--annotate"], run.io, { cwd: dir })).toBe(2);
        expect(run.err()).toContain(`Could not write ${join(dir, "copy.gaugeline.csv")}`);
        expect(run.out()).toContain("Two rows in the plan share one address");
      } finally {
        chmodSync(dir, 0o755);
      }
    }
  });

  it("--base: the built site against the plan prints the docs Output block and exits 1", async () => {
    const site = await startFixture("plan-built");
    try {
      const dir = mkdtempSync(join(tmpdir(), "gaugeline-built-"));
      dirs.push(dir);
      cpSync(join(SITES_DIR, "plan-built", "plan.csv"), join(dir, "plan.csv"));
      const run = capture();
      expect(
        await main(["plan", "plan.csv", "--base", site.origin, "--allow-private"], run.io, {
          cwd: dir,
        }),
      ).toBe(1);
      expect(withoutPassed(run.out()).trimEnd()).toBe(
        expectedOutput("plan-check", "The built site against the plan"),
      );
      expect(run.err()).toContain(`Reading 8 planned addresses on ${site.origin}`);
      expect(site.hits.get("/classes")).toBe(1);
    } finally {
      await site.close();
    }
  });

  it("--base with a Legacy URL column checks the 301 map and prints the docs Output block", async () => {
    const site = await startFixture("plan-redirects");
    try {
      const dir = mkdtempSync(join(tmpdir(), "gaugeline-redirects-"));
      dirs.push(dir);
      cpSync(join(SITES_DIR, "plan-redirects", "plan.csv"), join(dir, "plan.csv"));
      const run = capture();
      expect(
        await main(["plan", "plan.csv", "--base", site.origin, "--allow-private"], run.io, {
          cwd: dir,
        }),
      ).toBe(1);
      expect(withoutPassed(run.out()).trimEnd()).toBe(expectedOutput("plan-check", "The 301 map"));
      expect(run.err()).toContain("Reading 8 old addresses from the Legacy URL column\n");
      expect(run.err()).toContain(
        "/old-kids redirects with 308 (permanent, keeps the method): accepted like a 301",
      );
      expect([...site.methods.keys()]).toEqual(["GET"]);
    } finally {
      await site.close();
    }
  });

  it("--live: the pages that exist today with no row, sorted by clicks, as the docs show", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-live-"));
    dirs.push(dir);
    for (const f of ["plan.csv", "search-console.csv"])
      cpSync(join(SITES_DIR, "..", "plans", "live", f), join(dir, f));
    const run = capture();
    expect(
      await main(["plan", "plan.csv", "--live", "search-console.csv"], run.io, { cwd: dir }),
    ).toBe(1);
    expect(withoutPassed(run.out()).trimEnd()).toBe(
      expectedOutput("plan-check", "Live pages the plan misses"),
    );
    expect(run.err()).toContain(
      "Read 3 live addresses from search-console.csv (a Search Console export, sorted by clicks); 0 left out as assets, feeds, paged or --ignore",
    );
    // Without --live the check is skipped, not passed.
    const none = capture();
    await main(["plan", "plan.csv"], none.io, { cwd: dir });
    expect(none.out()).not.toContain("plan-uncovered-page");
    // --ignore leaves a path out; a missing file is exit 2.
    const ignored = capture();
    expect(
      await main(
        [
          "plan",
          "plan.csv",
          "--live",
          "search-console.csv",
          "--ignore",
          "/specialties/**",
          "--ignore",
          "/outsourced-*",
        ],
        ignored.io,
        { cwd: dir },
      ),
    ).toBe(0);
    expect(await main(["plan", "plan.csv", "--live", "nope.csv"], capture().io, { cwd: dir })).toBe(
      2,
    );
  });

  it("--rank: the uncovered list highest clicks first, with the summary line; --rank without --live is exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-rank-"));
    dirs.push(dir);
    for (const f of ["plan.csv", "crawl.csv", "gsc-pages.csv", "search-console.csv"])
      cpSync(join(SITES_DIR, "..", "plans", "live", f), join(dir, f));
    const run = capture();
    expect(
      await main(["plan", "plan.csv", "--live", "crawl.csv", "--rank", "gsc-pages.csv"], run.io, {
        cwd: dir,
      }),
    ).toBe(1);
    expect(withoutPassed(run.out()).trimEnd()).toBe(
      expectedOutput("plan-check", "Adding traffic numbers"),
    );
    const alone = capture();
    expect(
      await main(["plan", "plan.csv", "--rank", "gsc-pages.csv"], alone.io, { cwd: dir }),
    ).toBe(2);
    expect(alone.err()).toContain(
      "--rank adds traffic numbers to the pages --live finds missing from the plan: add --live.",
    );
    // The Queries tab: exit 2 naming the export to download.
    writeFileSync(
      join(dir, "queries.csv"),
      "Top queries,Clicks,Impressions,CTR,Position\nbilling,4,40,10%,3\n",
    );
    const queries = capture();
    expect(
      await main(["plan", "plan.csv", "--live", "crawl.csv", "--rank", "queries.csv"], queries.io, {
        cwd: dir,
      }),
    ).toBe(2);
    expect(queries.err()).toContain("open the Pages tab and export that");
  });

  it("--nav: the per-tab counts first, then the menu findings, as the docs show; exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-nav-"));
    dirs.push(dir);
    cpSync(join(SITES_DIR, "..", "plans", "nav-workbook.txt"), join(dir, "nav-workbook.txt"));
    const run = capture();
    expect(
      await main(["plan", "nav-workbook.txt", "--plan-only", "--nav"], run.io, { cwd: dir }),
    ).toBe(1);
    expect(withoutPassed(run.out()).trimEnd()).toBe(
      expectedOutput("plan-check", "Menus against pages"),
    );
    expect(run.out().split("\n")[3]).toBe("Solutions: 4 items in 1 category");
    expect(run.err()).toContain("Resources: no menu items were read.");
    // Naming tabs reads only those; naming the page plan, or a one-tab CSV, is exit 2.
    const two = capture();
    await main(
      ["plan", "nav-workbook.txt", "--plan-only", "--nav", "Who We Serve,Footer"],
      two.io,
      { cwd: dir },
    );
    expect(two.out()).toContain(
      "Who We Serve: 6 items in 2 categories\nFooter: 5 items in 2 categories\n",
    );
    expect(two.out()).not.toContain("Solutions:");
    const pagePlan = capture();
    expect(
      await main(["plan", "nav-workbook.txt", "--nav", "Page plan"], pagePlan.io, { cwd: dir }),
    ).toBe(2);
    expect(pagePlan.err()).toContain("that is the page plan, not a menu");
    writeFileSync(join(dir, "one.csv"), "URL,Page\n/a,A\n");
    const one = capture();
    expect(await main(["plan", "one.csv", "--nav"], one.io, { cwd: dir })).toBe(2);
    expect(one.err()).toContain("--nav: no menu tab was found");
  });

  it("a legacy address claimed by two rows is a conflict without --base", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "claims.csv"), "URL,Legacy URL\n/a,/old\n/b,/old\n");
    const run = capture();
    expect(await main(["plan", "claims.csv"], run.io, { cwd: dir })).toBe(1);
    expect(run.out()).toContain(
      "✗ One old address is claimed by two rows\n    /old is the legacy address of 2 rows: /a, /b\n    lines 2, 3",
    );
    expect(run.out()).not.toContain("plan-redirect-missing");
  });

  it("--base with --plan-only, or a preview behind a login: exit 2", async () => {
    const dir = workdir();
    let run = capture();
    expect(
      await main(
        ["plan", "keyword-map.csv", "--plan-only", "--base", "https://preview.example"],
        run.io,
        { cwd: dir },
      ),
    ).toBe(2);
    expect(run.err()).toContain("Choose --plan-only or --base");
    const site = await startFixture("refusing");
    try {
      writeFileSync(join(dir, "small.csv"), "URL\n/\n/a\n/b\n");
      run = capture();
      expect(
        await main(["plan", "small.csv", "--base", site.origin, "--allow-private"], run.io, {
          cwd: dir,
        }),
      ).toBe(2);
      expect(run.err()).toContain(
        `Could not check: the preview at ${site.origin} refused the request (403). It did not ask for a password`,
      );
      expect(run.out()).not.toContain("returned 404");
    } finally {
      await site.close();
    }
  });
});
