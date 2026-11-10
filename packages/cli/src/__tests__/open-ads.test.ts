import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import type { AdsEngine, AdsOutcome } from "@gaugeline/app-server";
import { buildResult } from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { scratchClientDir } from "../../../app-server/src/__tests__/helpers/client.js";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { EXIT, main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const ADS = fileURLToPath(new URL("../../../fixtures/ads/", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-open-ads-"));
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

const CSV = [
  "Ad name,Website URL,Amount spent (USD)",
  "Happy hour,https://tapas-bar.example/happy-hour,1204.50",
  "Old menu,https://tapas-bar.example/old-menu,999.99",
].join("\n");
const file = (name = "ads-export.csv", text = CSV) => {
  const path = join(scratch(), name);
  writeFileSync(path, text);
  return path;
};

const outcome = (): AdsOutcome => ({
  result: buildResult({
    url: "ads-export.csv",
    startedAt: new Date("2026-11-10T09:00:00Z"),
    findings: [],
    passed: [],
    failed: [],
    couldNotCheck: [],
    sampled: {},
  }),
  ads: {
    currencies: [
      {
        currency: "USD",
        destinations: [{ url: "https://tapas-bar.example/happy-hour", ads: 1, spend: 120450 }],
      },
    ],
  },
});

/** Stands in for the ads command: it needs a link and an amount-spent column. */
function engine(calls: { read: number; check: number }): AdsEngine<string> {
  return {
    read(text) {
      calls.read++;
      const header = text.split("\n")[0] ?? "";
      if (!/spen[dt]/i.test(header))
        throw new Error(
          `The export has no amount-spent column. These are the columns it has: ${header}.`,
        );
      return text;
    },
    async check(_t, ctx) {
      calls.check++;
      ctx.onProgress("Checking 1 landing page");
      return outcome();
    },
  };
}

describe("gaugeline open --ads: arguments", () => {
  it("--ads <file> is the export to read, with no address", () => {
    expect(parseCliArgs(["open", "--ads", "ads-export.csv"])).toMatchObject({
      kind: "open",
      ads: "ads-export.csv",
      demo: false,
    });
    expect(parseCliArgs(["open"])).not.toHaveProperty("ads");
  });

  it("is a flag of open alone, in the table the docs and --help are made from", () => {
    expect(FLAGS.find((f) => f.name === "ads")).toMatchObject({
      type: "string",
      commands: ["open"],
    });
    expect(parseCliArgs(["ads-export.csv", "--ads", "x.csv"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["launch", "example.com", "--ads", "x.csv"])).toMatchObject({
      kind: "error",
    });
  });

  it("no file name, or an empty one, is a usage error that names the fix", () => {
    for (const argv of [
      ["open", "--ads"],
      ["open", "--ads", ""],
      ["open", "--ads", "  "],
    ]) {
      const parsed = parseCliArgs(argv);
      expect(parsed.kind, argv.join(" ")).toBe("error");
    }
    expect(parseCliArgs(["open", "--ads", " "])).toMatchObject({
      message: expect.stringContaining("--ads needs the ads export file"),
    });
  });

  it("--demo with --ads is its own usage error, exit 2, and starts nothing", async () => {
    const c = capture();
    expect(await main(["open", "--demo", "--ads", "x.csv"], c.io)).toBe(EXIT.couldNotRun);
    expect(c.err()).toContain("--demo and --ads cannot be used together");
    expect(c.err()).not.toMatch(/unknown option|unknown flag/i);
    expect(c.out()).toBe("");
  });

  it("--ads with an address is a usage error", async () => {
    const c = capture();
    expect(await main(["open", "--ads", "x.csv", "shop.example"], c.io)).toBe(EXIT.couldNotRun);
    expect(c.err()).toContain("gaugeline open --ads takes no address");
    expect(c.out()).toBe("");
  });

  it("--help for open lists it", async () => {
    const c = capture();
    expect(await main(["open", "--help"], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain("--ads");
  });
});

describe("gaugeline open --ads: starting", () => {
  const run = (args: string[], eng: AdsEngine, clientDir = scratchClientDir()) => {
    const c = capture();
    const stop = new AbortController();
    const done = main(["open", ...args, "--no-open"], c.io, {
      clientDir,
      ads: eng,
      stop: stop.signal,
    });
    return { c, stop, done };
  };

  it("reads the file once, before the app starts, runs it, and stops on request", async () => {
    const calls = { read: 0, check: 0 };
    const { c, stop, done } = run(["--ads", file()], engine(calls));
    await expect.poll(() => c.out(), { timeout: 10_000 }).toContain("Gaugeline is running at");
    expect(c.out()).toContain("Checking 1 landing page");
    expect(calls).toEqual({ read: 1, check: 1 });
    stop.abort();
    expect(await done).toBe(EXIT.ok);
  });

  it("a path with spaces and a non-ASCII name works, and the folder is never printed", async () => {
    const dir = join(scratch(), "Clientes de María");
    mkdirSync(dir);
    const path = join(dir, "campaña de otoño.csv");
    writeFileSync(path, CSV);
    const { c, stop, done } = run(["--ads", path], engine({ read: 0, check: 0 }));
    await expect.poll(() => c.out(), { timeout: 10_000 }).toContain("Gaugeline is running at");
    expect(c.out()).not.toContain("Clientes");
    stop.abort();
    expect(await done).toBe(EXIT.ok);
  });

  it("a missing file exits 2 with one sentence, before any server starts", async () => {
    const calls = { read: 0, check: 0 };
    const { c, done } = run(["--ads", join(scratch(), "nope.csv")], engine(calls));
    expect(await done).toBe(EXIT.couldNotRun);
    expect(c.err()).toContain("Gaugeline cannot read");
    expect(c.err()).toContain("there is no file there");
    expect(c.out()).not.toContain("Gaugeline is running");
    expect(calls).toEqual({ read: 0, check: 0 });
  });

  it("an export with no spend column exits 2 with the ads command's message and starts no server", async () => {
    const calls = { read: 0, check: 0 };
    const path = file("no-spend.csv", "Ad name,Website URL\nHappy hour,https://tapas-bar.example/");
    const { c, done } = run(["--ads", path], engine(calls));
    expect(await done).toBe(EXIT.couldNotRun);
    expect(c.err()).toContain(
      "The export has no amount-spent column. These are the columns it has: Ad name,Website URL.",
    );
    expect(c.out()).not.toContain("Gaugeline is running");
    expect(calls).toEqual({ read: 1, check: 0 });
  });
});

describe("gaugeline open --ads: the ads command that ships with this version", () => {
  const FIXED = new Date("2026-11-10T09:00:00Z");

  /** One GET to the app on 127.0.0.1, with the Host and cookie a browser would send. */
  function get(port: number, path: string, cookie = ""): Promise<{ head: string; body: string }> {
    return new Promise((resolve, reject) => {
      const c = connect({ host: "127.0.0.1", port }, () =>
        c.write(
          `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ""}Connection: close\r\n\r\n`,
        ),
      );
      let data = "";
      c.on("data", (d: Buffer) => (data += d.toString()));
      c.on("end", () => {
        const i = data.indexOf("\r\n\r\n");
        resolve({ head: data.slice(0, i), body: data.slice(i + 4) });
      });
      c.on("error", reject);
    });
  }

  /** Start `open --ads <file>` in this process with the engine that ships, and call its API. */
  async function withApp<T>(
    path: string,
    use: (api: (path: string) => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    const c = capture();
    const stop = new AbortController();
    const done = main(["open", "--ads", path, "--no-open"], c.io, {
      clientDir: scratchClientDir(),
      stop: stop.signal,
      now: () => FIXED,
    });
    try {
      await expect.poll(() => c.out(), { timeout: 10_000 }).toContain("Gaugeline is running at");
      const link = new URL(/Gaugeline is running at (\S+)/.exec(c.out())?.[1] ?? "");
      const port = Number(link.port);
      const first = await get(port, `/${link.search}`);
      const cookie = /^set-cookie: ([^;]+)/im.exec(first.head)?.[1] ?? "";
      // The run is added when the server starts and finishes on its own; wait for it to be done.
      const api = async (p: string) => JSON.parse((await get(port, p, cookie)).body) as unknown;
      await expect
        .poll(async () => ((await api("/api/runs")) as { state: string }[])[0]?.state, {
          timeout: 10_000,
        })
        .toBe("done");
      return await use(api);
    } finally {
      stop.abort();
      expect(await done).toBe(EXIT.ok);
    }
  }

  it("lists one run of kind ads whose result deep-equals `gaugeline ads --json`", async () => {
    const path = join(ADS, "meta.csv");
    const command = capture();
    expect(await main(["ads", path, "--json"], command.io, { now: () => FIXED })).toBe(EXIT.ok);
    const expected: unknown = JSON.parse(command.out());

    await withApp(path, async (api) => {
      const runs = (await api("/api/runs")) as { id: string; kind: string; url: string }[];
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: "ads", url: "meta.csv" });
      const run = (await api(`/api/runs/${runs[0]?.id}`)) as {
        result: unknown;
        checked: { ads: { currencies: { currency: string; destinations: unknown[] }[] } };
      };
      expect(run.result).toEqual(expected);
      // The spend behind the destinations: integers in minor units, summed per page.
      expect(run.checked.ads.currencies).toEqual([
        {
          currency: "USD",
          destinations: [
            { url: "https://tapas-bar.example/happy-hour", ads: 5, spend: 120450 },
            { url: "https://tapas-bar.example/old-menu", ads: 1, spend: 99999 },
            { url: "https://tapas-bar.example/book-a-table", ads: 3, spend: 80000 },
            { url: "https://tapas-bar.example/gift-cards", ads: 3, spend: 15075 },
          ],
        },
      ]);
    });
  });

  it("12 ads over 4 destinations ask the fixture for at most one page each, only by GET or HEAD", async () => {
    const site = await startFixture("clean");
    try {
      const paths = ["", "about.html", "menu.html", "missing.html"];
      const path = file(
        "local-ads.csv",
        [
          "Ad name,Website URL,Amount spent (USD)",
          ...Array.from(
            { length: 12 },
            (_, i) => `Ad ${i},${site.origin}/${paths[i % 4]}?utm_campaign=c${i},10.00`,
          ),
        ].join("\n"),
      );
      await withApp(path, async (api) => {
        const runs = (await api("/api/runs")) as { id: string }[];
        const run = (await api(`/api/runs/${runs[0]?.id}`)) as {
          checked: { ads: { currencies: { destinations: unknown[] }[] } };
        };
        expect(run.checked.ads.currencies[0]?.destinations).toHaveLength(4);
      });
      // The pages are checked in G24a and G24b, one request per destination. Until then this
      // version asks for none; the bound holds in both cases, and G24a makes it exactly 4.
      expect(site.total).toBeLessThanOrEqual(4);
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("an export with no link column exits 2 with the headers it found, and no server starts", async () => {
    const c = capture();
    const code = await main(["open", "--ads", join(ADS, "no-link.csv"), "--no-open"], c.io, {
      clientDir: scratchClientDir(),
    });
    expect(code).toBe(EXIT.couldNotRun);
    expect(c.err()).toContain("Headers found: Ad name, Impressions, Amount spent (USD).");
    expect(c.out()).not.toContain("Gaugeline is running");
  });

  it("the built bin: an export with no spend column exits 2 and prints no link", async () => {
    const r = await runBin(["open", "--ads", join(ADS, "no-spend.csv"), "--no-open"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("The export has no amount-spent column.");
    expect(r.stdout).toBe("");
  });
});
