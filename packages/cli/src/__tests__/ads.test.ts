import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseResult } from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { EXIT, main } from "../main.js";
import { okSite, recordingSite, tapasSite } from "./helpers/ads-site.js";
import { runBin } from "./helpers/bin.js";

const ADS = fileURLToPath(new URL("../../../fixtures/ads/", import.meta.url));
const SHOP = "https://tapas-bar.example";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-ads-cmd-"));
  dirs.push(d);
  return d;
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("gaugeline ads: arguments", () => {
  it("takes one export file", () => {
    expect(parseCliArgs(["ads", "ads-export.csv"])).toMatchObject({
      kind: "ads",
      file: "ads-export.csv",
      json: false,
    });
    expect(parseCliArgs(["ads", "ads-export.csv", "--json"])).toMatchObject({ json: true });
  });

  it("no file, or two, is a usage error that shows the fix", () => {
    for (const argv of [["ads"], ["ads", "a.csv", "b.csv"]]) {
      expect(parseCliArgs(argv), argv.join(" ")).toMatchObject({
        kind: "error",
        message: expect.stringContaining("gaugeline ads needs one ads export"),
      });
    }
  });

  it("--json is a flag of ads too, in the table the docs and --help are made from", () => {
    expect(FLAGS.find((f) => f.name === "json")?.commands).toContain("ads");
    expect(parseCliArgs(["ads", "a.csv", "--ci"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["ads", "a.csv", "--ads", "b.csv"])).toMatchObject({ kind: "error" });
  });

  it("--help lists it", async () => {
    const c = capture();
    expect(await main(["ads", "--help"], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain("gaugeline ads <export.csv>");
    expect(c.out()).toContain("--json");
  });
});

describe("gaugeline ads: e2e", () => {
  it("fixtures/meta.csv prints four lines in spend order and exits 0", async () => {
    const c = capture();
    expect(
      await main(["ads", join(ADS, "meta.csv")], c.io, { fetcher: { transport: okSite } }),
    ).toBe(EXIT.ok);
    const lines = c.out().trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual([
      `${SHOP}/happy-hour`,
      `${SHOP}/old-menu`,
      `${SHOP}/book-a-table`,
      `${SHOP}/gift-cards`,
    ]);
    expect(lines.map((l) => l.replace(/\s+/g, " "))).toEqual([
      `${SHOP}/happy-hour 5 ads 1204.50 USD`,
      `${SHOP}/old-menu 1 ad 999.99 USD`,
      `${SHOP}/book-a-table 3 ads 800.00 USD`,
      `${SHOP}/gift-cards 3 ads 150.75 USD`,
    ]);
  });

  it("fixtures/no-link.csv exits 2 and names the headers; nothing is printed on stdout", async () => {
    const c = capture();
    expect(
      await main(["ads", join(ADS, "no-link.csv")], c.io, { fetcher: { transport: okSite } }),
    ).toBe(EXIT.couldNotRun);
    expect(c.err()).toContain("The export has no link column.");
    expect(c.err()).toContain("Headers found: Ad name, Impressions, Amount spent (USD).");
    expect(c.out()).toBe("");
  });

  it("fixtures/no-spend.csv exits 2 and names the headers", async () => {
    const c = capture();
    expect(
      await main(["ads", join(ADS, "no-spend.csv")], c.io, { fetcher: { transport: okSite } }),
    ).toBe(EXIT.couldNotRun);
    expect(c.err()).toContain("The export has no amount-spent column.");
    expect(c.err()).toContain("Headers found: Ad name, Website URL, Impressions.");
  });

  it("a missing file or a folder exits 2 in one sentence, without a stack", async () => {
    const dir = scratch();
    const missing = capture();
    expect(await main(["ads", join(dir, "nope.csv")], missing.io)).toBe(EXIT.couldNotRun);
    expect(missing.err()).toContain("Gaugeline cannot read");
    expect(missing.err()).toContain("there is no file there");
    const folder = capture();
    expect(await main(["ads", dir], folder.io)).toBe(EXIT.couldNotRun);
    expect(folder.err()).toContain("that is a folder, not a file");
    expect(`${missing.err()}${folder.err()}`).not.toMatch(/\n\s+at /);
  });

  it("a relative path is read from the working folder", async () => {
    const c = capture();
    expect(
      await main(["ads", "meta.csv"], c.io, { cwd: ADS, fetcher: { transport: okSite } }),
    ).toBe(EXIT.ok);
    expect(c.out().trimEnd().split("\n")).toHaveLength(4);
  });

  it("the Google export: a preamble and totals rows, euros, three destinations' worth of ads", async () => {
    const c = capture();
    expect(
      await main(["ads", join(ADS, "google.csv")], c.io, { fetcher: { transport: okSite } }),
    ).toBe(EXIT.ok);
    expect(
      c
        .out()
        .trimEnd()
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ")),
    ).toEqual([`${SHOP}/book-a-table 1 ad 60.00 EUR`, `${SHOP}/gift-cards 2 ads 40.00 EUR`]);
    expect(c.err()).not.toContain("skipped");
  });

  it("a UTF-16 export with a byte order mark (Google's Excel CSV) is read the same", async () => {
    const dir = scratch();
    const text = readFileSync(join(ADS, "meta.csv"), "utf8");
    const path = join(dir, "utf16.csv");
    writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    const utf16 = capture();
    const plain = capture();
    expect(await main(["ads", path], utf16.io, { fetcher: { transport: okSite } })).toBe(EXIT.ok);
    expect(
      await main(["ads", join(ADS, "meta.csv")], plain.io, { fetcher: { transport: okSite } }),
    ).toBe(EXIT.ok);
    expect(utf16.out()).toBe(plain.out());
  });

  it("mixed currencies: each page lists its currencies, and none is added to another", async () => {
    const c = capture();
    expect(
      await main(["ads", join(ADS, "mixed-currency.csv")], c.io, {
        fetcher: { transport: okSite },
      }),
    ).toBe(EXIT.ok);
    const lines = c
      .out()
      .trimEnd()
      .split("\n")
      .map((l) => l.replace(/\s+/g, " "));
    expect(lines).toEqual([
      `${SHOP}/gift-cards 3 ads 40.00 EUR + 25.00 USD`,
      `${SHOP}/happy-hour 1 ad 15.00 EUR`,
      `${SHOP}/book-a-table 1 ad 12.00 USD`,
    ]);
  });

  it("warnings go to stderr, never into the lines on stdout, and --quiet leaves them out", async () => {
    const dir = scratch();
    const path = join(dir, "messy.csv");
    writeFileSync(
      path,
      `Link,Spend\ntapas-bar.example/menu,12.00\n,3.00\n${SHOP}/menu,"1.204,50"\n`,
    );
    const loud = capture();
    expect(await main(["ads", path], loud.io, { fetcher: { transport: okSite } })).toBe(EXIT.ok);
    expect(loud.err()).toContain("1 row had no link and was skipped");
    expect(loud.err()).toContain("no http:// or https://");
    expect(loud.err()).toMatch(/ambiguous/i);
    expect(loud.out().trimEnd().split("\n")).toHaveLength(1);
    expect(loud.out()).not.toMatch(/skipped|ambiguous/i);
    const quiet = capture();
    expect(await main(["ads", path, "--quiet"], quiet.io, { fetcher: { transport: okSite } })).toBe(
      EXIT.ok,
    );
    expect(quiet.err()).toBe("");
    expect(quiet.out()).toBe(loud.out());
  });

  it("--json prints one schema 2 result on stdout and nothing else", async () => {
    const c = capture();
    const now = () => new Date("2026-11-10T09:00:00Z");
    expect(
      await main(["ads", join(ADS, "meta.csv"), "--json"], c.io, {
        now,
        fetcher: { transport: okSite },
      }),
    ).toBe(EXIT.ok);
    const result = parseResult(JSON.parse(c.out()));
    expect(result).toMatchObject({
      schema: 2,
      startedAt: "2026-11-10T09:00:00.000Z",
      findings: [],
    });
    // The export's text never reaches the result: no ad name, no amount.
    expect(c.out()).not.toContain("Happy hour");
    expect(c.out()).not.toContain("1204");
  });

  it("an export with no ads at all still exits 0 and says so on stderr", async () => {
    const dir = scratch();
    const path = join(dir, "empty.csv");
    writeFileSync(path, "Link,Spend\n");
    const c = capture();
    expect(await main(["ads", path], c.io, { fetcher: { transport: okSite } })).toBe(EXIT.ok);
    expect(c.out()).toBe("");
    expect(c.err()).toContain("no ads");
  });

  it("asks each landing page once: 12 ads over 4 destinations are exactly 4 first requests, GET only", async () => {
    const site = await startFixture("clean");
    try {
      const path = join(scratch(), "local.csv");
      writeFileSync(
        path,
        [
          "Ad name,Website URL,Amount spent (USD)",
          ...Array.from(
            { length: 12 },
            (_, i) =>
              `Ad ${i},${site.origin}/${["", "about.html", "menu.html", "x"][i % 4]}?utm_campaign=c${i},5.00`,
          ),
        ].join("\n"),
      );
      const c = capture();
      expect(await main(["ads", path, "--allow-private"], c.io)).toBe(EXIT.ok);
      expect(site.total).toBe(4);
      expect([...site.methods.keys()]).toEqual(["GET"]);
      expect(site.maxConcurrent).toBeLessThanOrEqual(5);
      // The tags arrive (the fixture never redirects), so nothing is added under the four lines.
      expect(c.out().trimEnd().split("\n")).toHaveLength(4);
    } finally {
      await site.close();
    }
  });

  it("sends the first ad's own tags to each page, and Gaugeline's own when a page has none", async () => {
    const site = recordingSite();
    const c = capture();
    expect(
      await main(["ads", join(ADS, "meta.csv")], c.io, { fetcher: { transport: site.transport } }),
    ).toBe(EXIT.ok);
    expect(site.urls.sort()).toEqual([
      `${SHOP}/book-a-table?utm_source=facebook&utm_medium=paid&utm_campaign=autumn-menu`,
      `${SHOP}/gift-cards?utm_source=facebook&utm_medium=paid&utm_campaign=gifts`,
      `${SHOP}/happy-hour?utm_source=facebook&utm_medium=paid&utm_campaign=autumn-menu`,
      `${SHOP}/old-menu?utm_source=gaugeline-check&gclid=test`,
    ]);
    expect(new Set(site.methods)).toEqual(new Set(["GET"]));
  });

  it("a page that drops the tags is named under the lines, with the redirect and the spend", async () => {
    const c = capture();
    expect(
      await main(["ads", join(ADS, "meta.csv")], c.io, { fetcher: { transport: tapasSite } }),
    ).toBe(EXIT.ok);
    const [lines, ...rest] = c.out().split("\n\n");
    const report = rest.join("\n\n");
    expect(lines?.split("\n")).toHaveLength(4);
    expect(report).toContain("Campaign tags are lost");
    expect(report).toContain(`the 301 from ${SHOP}/gift-cards to ${SHOP}/shop/gift-cards`);
    expect(report).toContain("utm_source, utm_medium, utm_campaign");
    expect(report).toContain("150.75 USD");
    expect(report).toContain("1 to look at, 1 to fix first.");
    const quiet = capture();
    await main(["ads", join(ADS, "meta.csv"), "--quiet"], quiet.io, {
      fetcher: { transport: tapasSite },
    });
    expect(quiet.out()).toBe(c.out());
  });

  it("--json carries the finding, and --ci is not a flag of this command", async () => {
    const c = capture();
    expect(
      await main(["ads", join(ADS, "meta.csv"), "--json"], c.io, {
        fetcher: { transport: tapasSite },
      }),
    ).toBe(EXIT.ok);
    const result = parseResult(JSON.parse(c.out()));
    expect(result.findings.map((f) => [f.checkId, f.severity, f.url])).toEqual([
      ["campaign-fields-lost", "high", `${SHOP}/gift-cards`],
    ]);
    expect(result.passed).toEqual([]);
  });

  it("a page that cannot be reached is listed as not checked, with exit 0", async () => {
    const c = capture();
    const down = () => Promise.reject(new Error("offline"));
    expect(
      await main(["ads", join(ADS, "google.csv")], c.io, { fetcher: { transport: down } }),
    ).toBe(EXIT.ok);
    expect(c.out()).toContain("campaign-fields-lost could not be checked");
    expect(c.out()).not.toContain("1 to look at");
  });
});

describe("gaugeline ads: the built bin", () => {
  it("prints the four lines and exits 0; a file without a link column exits 2", async () => {
    const site = await startFixture("clean");
    try {
      const path = join(scratch(), "bin.csv");
      writeFileSync(
        path,
        [
          "Ad name,Website URL,Amount spent (USD)",
          ...["", "about.html", "menu.html", "x"].map(
            (p, i) => `Ad ${i},${site.origin}/${p}?utm_source=facebook,5.00`,
          ),
        ].join("\n"),
      );
      const ok = await runBin(["ads", path, "--allow-private"]);
      expect(ok.status).toBe(0);
      expect(ok.stdout.trimEnd().split("\n")).toHaveLength(4);
      expect(site.total).toBe(4);
    } finally {
      await site.close();
    }
    const bad = await runBin(["ads", join(ADS, "no-link.csv")]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Headers found: Ad name, Impressions, Amount spent (USD).");
  });
});
