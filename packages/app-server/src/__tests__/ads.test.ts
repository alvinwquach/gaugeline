import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResult, type Transport } from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdsInputError,
  loadAdsFile,
  type AdsContext,
  type AdsData,
  type AdsEngine,
  type AdsOutcome,
} from "../ads.js";
import { DemoError } from "../demo.js";
import { startApp } from "../server.js";
import { testClientDir } from "./helpers/client.js";
import { client, raw } from "./helpers/http.js";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-ads-"));
  dirs.push(d);
  return d;
};

/** An invented Meta Ads Manager export for a tapas bar: ad names are what must never leave. */
const NAME_SECRET = "Autumn tapas - members only offer";
const CSV = [
  "Ad name,Website URL,Amount spent (USD)",
  `${NAME_SECRET},https://tapas-bar.example/happy-hour?utm_source=meta,1204.50`,
  "Book a table,https://tapas-bar.example/book-a-table,800.00",
  "Old menu,https://tapas-bar.example/old-menu,999.99",
].join("\n");

const ads: AdsData = {
  currencies: [
    {
      currency: "USD",
      destinations: [
        { url: "https://tapas-bar.example/happy-hour", ads: 5, spend: 120450 },
        { url: "https://tapas-bar.example/book-a-table", ads: 3, spend: 80000 },
        { url: "https://tapas-bar.example/old-menu", ads: 4, spend: 99999 },
      ],
    },
  ],
};
const outcome = (name: string, over: Partial<AdsOutcome> = {}): AdsOutcome => ({
  result: buildResult({
    url: name,
    startedAt: new Date("2026-11-10T09:00:00Z"),
    findings: [
      {
        checkId: "page-dead",
        severity: "high",
        title: "The page does not load",
        evidence: "404",
        url: "https://tapas-bar.example/old-menu",
      },
    ],
    passed: [],
    failed: [],
    couldNotCheck: [],
    sampled: {},
  }),
  ads,
  ...over,
});

/** Stands in for the ads command: it needs a link and an amount-spent column, as G24's reader does. */
function engine(
  check: (text: string, ctx: AdsContext) => Promise<AdsOutcome> | AdsOutcome,
  reads: string[] = [],
): AdsEngine<string> {
  return {
    read(text) {
      reads.push(text);
      const header = text.split("\n")[0] ?? "";
      if (!/url|link/i.test(header) || !/spen[dt]/i.test(header))
        throw new Error(
          `The export needs a link column and an amount-spent column. These are the columns it has: ${header}.`,
        );
      return text;
    },
    check: async (text, ctx) => check(text, ctx),
  };
}

const exportFile = (name = "ads-export.csv", text: string | Buffer = CSV) => {
  const dir = scratch();
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe("loadAdsFile: the file is read once, from the path the person typed", () => {
  it("hands the text to the engine once and names the run by the file's base name", () => {
    const reads: string[] = [];
    const path = exportFile("tapas campaign - Mayo.csv");
    const input = loadAdsFile(
      path,
      engine(() => outcome("x"), reads),
    );
    expect(reads).toEqual([CSV]);
    expect(input.name).toBe("tapas campaign - Mayo.csv");
    expect(input.name).not.toContain(tmpdir());
  });

  it("a path with spaces and a non-ASCII name works, and the name is the base name only", () => {
    const dir = join(scratch(), "Clientes de María");
    mkdirSync(dir);
    const path = join(dir, "campaña de otoño – café.csv");
    writeFileSync(path, CSV);
    const input = loadAdsFile(
      path,
      engine(() => outcome("x")),
    );
    expect(input.name).toBe("campaña de otoño – café.csv");
    expect(input.name).not.toMatch(/Clientes/);
  });

  it("is not read again: changing the file afterwards changes nothing", async () => {
    const reads: string[] = [];
    const path = exportFile();
    const input = loadAdsFile(
      path,
      engine(() => outcome("x"), reads),
    );
    writeFileSync(path, "Ad name,Website URL,Amount spent\nchanged,https://x.example/,1");
    expect(input.parsed).toBe(CSV);
    expect(reads).toHaveLength(1);
  });

  it("a missing file, a folder and an unreadable path each say so in one sentence", () => {
    const e = engine(() => outcome("x"));
    const dir = scratch();
    expect(() => loadAdsFile(join(dir, "nope.csv"), e)).toThrow(AdsInputError);
    expect(() => loadAdsFile(join(dir, "nope.csv"), e)).toThrow(/there is no file there/);
    expect(() => loadAdsFile(dir, e)).toThrow(/Gaugeline cannot read .*:/);
  });

  it("a file without the columns is the engine's message, unchanged", () => {
    const path = exportFile("no-spend.csv", "Ad name,Website URL\nA,https://a.example/");
    expect(() =>
      loadAdsFile(
        path,
        engine(() => outcome("x")),
      ),
    ).toThrow(
      "The export needs a link column and an amount-spent column. These are the columns it has: Ad name,Website URL.",
    );
  });

  it("reads a UTF-16 export (Google Ads' Excel CSV) as text", () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CSV, "utf16le")]);
    const reads: string[] = [];
    loadAdsFile(
      exportFile("google.csv", body),
      engine(() => outcome("x"), reads),
    );
    expect(reads).toEqual([CSV]);
  });
});

describe("startApp with an ads export", () => {
  it("lists one run of kind ads under the file's base name, with the result and the spend", async () => {
    const path = exportFile("ads-export.csv");
    const c = await client({
      ads: {
        file: path,
        engine: engine(
          (_t, ctx) => (ctx.onProgress("Checking 3 pages"), outcome("ads-export.csv")),
        ),
      },
    });
    closers.push(() => c.app.close());
    await c.app.firstRun;
    const list = (await c.call("GET", "/api/runs")).json() as unknown as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "ads", url: "ads-export.csv", state: "done" });
    expect(JSON.stringify(list)).not.toContain(tmpdir());
    const id = String(list[0]?.id);
    const run = (await c.call("GET", `/api/runs/${id}`)).json();
    expect(run.result).toEqual(outcome("ads-export.csv").result);
    expect(run.checked).toEqual({ ads });
    expect(run.counts).toEqual({ high: 1, medium: 0, low: 0 });
    expect(run).not.toHaveProperty("hasReport");
  });

  it("progress is on the same event stream as a page check: steps, then done", async () => {
    const steps: string[] = [];
    const c = await client({
      ads: {
        file: exportFile(),
        engine: engine((_t, ctx) => {
          ctx.onProgress("Reading 3 landing pages");
          ctx.onProgress("Checking https://tapas-bar.example/old-menu");
          return outcome("ads-export.csv");
        }),
      },
      onFirstStep: (t) => steps.push(t),
    });
    closers.push(() => c.app.close());
    const run = await c.app.firstRun;
    expect(steps).toEqual([
      "Reading 3 landing pages",
      "Checking https://tapas-bar.example/old-menu",
    ]);
    const stream = await raw(c.app.port, [`GET /api/runs/${run?.id}/events HTTP/1.1`, ...c.base]);
    expect([...stream.body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1])).toEqual([
      "step",
      "step",
      "done",
    ]);
  });

  it("the report download works when the engine gives a report, and says so when it does not", async () => {
    const withReport = await client({
      ads: {
        file: exportFile(),
        engine: engine(() =>
          outcome("ads-export.csv", {
            report: {
              result: {
                findings: outcome("x").result.findings,
                passed: [],
                failed: [],
                warnings: [],
                couldNotCheck: [],
                sampled: {},
              },
              url: "https://tapas-bar.example/",
            },
          }),
        ),
      },
    });
    closers.push(() => withReport.app.close());
    const run = await withReport.app.firstRun;
    const detail = (await withReport.call("GET", `/api/runs/${run?.id}`)).json();
    expect(detail.hasReport).toBe(true);
    expect((await withReport.call("GET", `/api/runs/${run?.id}/report`)).status).toBe(200);

    const bare = await client({
      ads: { file: exportFile(), engine: engine(() => outcome("ads-export.csv")) },
    });
    closers.push(() => bare.app.close());
    const bareRun = await bare.app.firstRun;
    const answer = await bare.call("GET", `/api/runs/${bareRun?.id}/report`);
    expect(answer.status).toBe(404);
    expect(answer.json().error).toBe("An ads check has no report to download.");
  });

  it("a run that fails says why, and the app still answers", async () => {
    const c = await client({
      ads: {
        file: exportFile(),
        engine: engine(() => {
          throw new Error("Nothing answered.");
        }),
      },
    });
    closers.push(() => c.app.close());
    const run = await c.app.firstRun;
    const detail = (await c.call("GET", `/api/runs/${run?.id}`)).json();
    expect(detail).toMatchObject({ kind: "ads", state: "failed", reason: "Nothing answered." });
  });

  it("spend that is not a whole number of cents fails the run rather than showing a float", async () => {
    const bad: AdsData = {
      currencies: [
        { currency: "USD", destinations: [{ url: "https://a.example/", ads: 1, spend: 19.99 }] },
      ],
    };
    const c = await client({
      ads: { file: exportFile(), engine: engine(() => outcome("x", { ads: bad })) },
    });
    closers.push(() => c.app.close());
    const run = await c.app.firstRun;
    const detail = (await c.call("GET", `/api/runs/${run?.id}`)).json();
    expect(detail.state).toBe("failed");
    expect(detail.reason).toMatch(/whole number/);
  });

  it("an unusable file stops the start: no port is taken, and the message is the engine's", async () => {
    const path = exportFile("no-spend.csv", "Ad name,Website URL\nA,https://a.example/");
    await expect(
      startApp({
        clientDir: testClientDir(),
        ads: { file: path, engine: engine(() => outcome("x")) },
      }),
    ).rejects.toThrow(/amount-spent column/);
    await expect(
      startApp({
        clientDir: testClientDir(),
        ads: { file: join(scratch(), "missing.csv"), engine: engine(() => outcome("x")) },
      }),
    ).rejects.toBeInstanceOf(AdsInputError);
  });

  it("with the demo or with an address it is refused before anything starts", async () => {
    const ok = { file: exportFile(), engine: engine(() => outcome("x")) };
    await expect(
      startApp({ clientDir: testClientDir(), demo: true, ads: ok }),
    ).rejects.toBeInstanceOf(DemoError);
    await expect(
      startApp({ clientDir: testClientDir(), address: "tapas-bar.example", ads: ok }),
    ).rejects.toThrow(/cannot be opened together/);
  });
});

describe("no route takes a file, a path or an upload", () => {
  it('POST /api/check with { "ads": "/etc/passwd" } is a 400 from the body validation', async () => {
    const c = await client({
      ads: { file: exportFile(), engine: engine(() => outcome("ads-export.csv")) },
    });
    closers.push(() => c.app.close());
    await c.app.firstRun;
    const answer = await c.call("POST", "/api/check", { ads: "/etc/passwd" });
    expect(answer.status).toBe(400);
    expect(answer.json().error).toBe('The only key is url: { "url": "yoursite.com" }.');
    expect((await c.call("GET", "/api/runs")).json()).toHaveLength(1);
  });

  it("there is no ads route: whatever the method or body, the API has no such address", async () => {
    const c = await client({
      ads: { file: exportFile(), engine: engine(() => outcome("ads-export.csv")) },
    });
    closers.push(() => c.app.close());
    await c.app.firstRun;
    for (const method of ["GET", "POST", "PUT"])
      for (const path of ["/api/ads", "/api/upload", "/api/runs/ads", "/api/open"]) {
        const answer = await c.call(
          method,
          path,
          method === "GET" ? undefined : { file: "/etc/passwd" },
        );
        expect([404, 405], `${method} ${path}`).toContain(answer.status);
        expect(answer.body).not.toContain("root:");
      }
    expect((await c.call("GET", "/api/runs")).json()).toHaveLength(1);
  });
});

describe("the requests an ads run makes", () => {
  /** An engine that asks for every destination it was given, as the ads command will. */
  const fetchAll = (urls: string[]) =>
    engine(async (_t, ctx) => {
      await Promise.all(urls.map((u) => ctx.fetcher.get(u)));
      return outcome("ads-export.csv");
    });

  it("one request per destination, and only GET or HEAD", async () => {
    const site = await startFixture("clean");
    closers.push(() => site.close());
    const urls = ["/", "/about.html", "/menu.html", "/robots.txt"].map((p) => `${site.origin}${p}`);
    const c = await client({
      fetcher: { allowPrivate: true },
      ads: { file: exportFile(), engine: fetchAll(urls) },
    });
    closers.push(() => c.app.close());
    await c.app.firstRun;
    expect(site.total).toBe(4);
    expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    expect(site.requests.map((r) => r.path).sort()).toEqual(
      ["/", "/about.html", "/menu.html", "/robots.txt"].sort(),
    );
  });

  it("2,000 ads over 300 destinations: five requests at most are in flight", async () => {
    const site = await startFixture("clean");
    closers.push(() => site.close());
    const urls = Array.from({ length: 300 }, (_, i) => `${site.origin}/?landing=${i}`);
    const c = await client({
      fetcher: { allowPrivate: true },
      ads: { file: exportFile(), engine: fetchAll(urls) },
    });
    closers.push(() => c.app.close());
    await c.app.firstRun;
    expect(site.total).toBe(300);
    expect(site.maxConcurrent).toBeLessThanOrEqual(5);
  });

  it("a destination on a private address is refused, as for any check", async () => {
    const site = await startFixture("clean");
    closers.push(() => site.close());
    let refused = "";
    const c = await client({
      ads: {
        file: exportFile(),
        engine: engine(async (_t, ctx) => {
          await ctx.fetcher.get(site.origin).catch((e: Error) => (refused = e.message));
          return outcome("ads-export.csv");
        }),
      },
    });
    closers.push(() => c.app.close());
    await c.app.firstRun;
    expect(site.total).toBe(0);
    expect(refused).toMatch(/non-public|private|loopback/i);
  });

  it("promise: nothing of the export's contents is in any request that leaves, and the names are only in answers from 127.0.0.1", async () => {
    const seen: { url: string; method: string; headers: string }[] = [];
    const transport: Transport = (url, req) => {
      seen.push({ url: url.href, method: req.method, headers: JSON.stringify(req.headers) });
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "text/html" },
        body: (async function* () {
          yield Buffer.from("<title>ok</title>");
        })() as never,
      });
    };
    const c = await client({
      fetcher: { transport },
      ads: {
        file: exportFile(),
        engine: engine(async (_t, ctx) => {
          for (const d of ads.currencies[0]?.destinations ?? []) await ctx.fetcher.get(d.url);
          return outcome("ads-export.csv");
        }),
      },
    });
    closers.push(() => c.app.close());
    await c.app.firstRun;
    expect(seen.map((s) => s.method).every((m) => m === "GET" || m === "HEAD")).toBe(true);
    expect(seen).toHaveLength(3);
    const out = JSON.stringify(seen);
    for (const secret of [NAME_SECRET, "1204.50", "120450", "Amount spent", "ads-export.csv"])
      expect(out).not.toContain(secret);
  });
});
