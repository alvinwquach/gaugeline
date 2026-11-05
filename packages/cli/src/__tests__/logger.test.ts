import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSite, createFetcher, type ProgressEvent } from "@gaugeline/core";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";
import { createLogger, progressLine } from "../logger.js";
import { bin, runBin } from "./helpers/bin.js";

const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
let site: FixtureServer;
beforeAll(async () => {
  site = await startServer({
    "/": (_q, res) =>
      void res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<html><head><title>t</title><link rel="canonical" href="${site.origin}/"></head><body><main><p>${words}</p>` +
            Array.from({ length: 24 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join("") +
            `<a href="https://elsewhere.example/">out</a></main></body></html>`,
        ),
  });
});
afterAll(() => site.close());

function recorder() {
  const lines: string[] = [];
  return { stream: { write: (s: string) => lines.push(s) }, text: () => lines.join("") };
}

const PROGRESS = [
  " Loading the page without JavaScript",
  " Reading robots.txt and the sitemap",
  " Checking 24 links on the page",
  " Scanning the site's JavaScript for leaked keys",
];

describe("logger: unit", () => {
  it("each ProgressEvent maps to its exact docs string, including the leading space", () => {
    expect(progressLine({ step: "load-page" })).toBe(PROGRESS[0]);
    expect(progressLine({ step: "robots-sitemap" })).toBe(PROGRESS[1]);
    expect(progressLine({ step: "links", count: 24 })).toBe(PROGRESS[2]);
    expect(progressLine({ step: "scripts" })).toBe(PROGRESS[3]);
  });

  it("links count 0 prints nothing, 1 prints 1 link, 24 prints 24 links", () => {
    expect(progressLine({ step: "links", count: 0 })).toBeUndefined();
    expect(progressLine({ step: "links", count: 1 })).toBe(" Checking 1 link on the page");
    expect(progressLine({ step: "links", count: 24 })).toBe(" Checking 24 links on the page");
  });

  it("level quiet: progress and warn write nothing, error writes", () => {
    const r = recorder();
    const log = createLogger({ level: "quiet", stream: r.stream });
    log.progress({ step: "load-page" });
    log.warn("w");
    log.debug("d");
    expect(r.text()).toBe("");
    log.error("e");
    expect(r.text()).toBe("e\n");
  });

  it("level verbose: debug writes; level normal: debug writes nothing", () => {
    const v = recorder();
    createLogger({ level: "verbose", stream: v.stream }).debug("hello");
    expect(v.text()).toBe("debug hello\n");
    const n = recorder();
    const normal = createLogger({ level: "normal", stream: n.stream });
    normal.debug("hello");
    normal.progress({ step: "debug", message: "x" });
    expect(n.text()).toBe("");
    normal.warn("careful");
    expect(n.text()).toBe("warning: careful\n");
  });

  it("a debug line for https://example.com/a?token=abc contains /a and not token or abc", () => {
    const r = recorder();
    createLogger({ level: "verbose", stream: r.stream }).request({
      method: "GET",
      url: "https://example.com/a?token=abc",
      status: 200,
      ms: 12,
    });
    expect(r.text()).toBe("debug GET https://example.com/a 200 12ms\n");
    expect(r.text()).not.toMatch(/token|abc/);
  });

  it("a closed stream never throws", () => {
    const log = createLogger({
      level: "normal",
      stream: {
        write: () => {
          throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        },
      },
    });
    expect(() => log.progress({ step: "load-page" })).not.toThrow();
  });
});

describe("logger: integration", () => {
  it("checkSite with a recording sink emits load-page, robots-sitemap, links, scripts in order, once each", async () => {
    const events: ProgressEvent[] = [];
    await checkSite({
      address: `${site.origin}/`,
      fetcher: createFetcher({ allowPrivate: true }),
      onProgress: (e) => events.push(e),
    });
    expect(events.filter((e) => e.step !== "warn" && e.step !== "debug")).toEqual([
      { step: "load-page" },
      { step: "robots-sitemap" },
      { step: "links", count: 24 },
      { step: "scripts" },
    ]);
  });
});

describe("logger: e2e (both streams captured separately)", () => {
  it("default run: stderr has the four progress lines in order; stdout has none of them", async () => {
    const r = await runBin([`${site.origin}/`]);
    const lines = r.stderr.split("\n");
    const at = PROGRESS.map((l) => lines.indexOf(l));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const l of PROGRESS) expect(r.stdout).not.toContain(l.trim());
  });

  it("--json: stdout is exactly one JSON document; progress is on stderr", async () => {
    const r = await runBin([`${site.origin}/`, "--json"]);
    expect(() => JSON.parse(r.stdout) as unknown).not.toThrow();
    expect(r.stderr).toContain(PROGRESS[0]);
  });

  it("--json --quiet: stderr is empty on a clean run", async () => {
    const r = await runBin([`${site.origin}/`, "--json", "--quiet"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it('--verbose: stderr has a "debug GET" line with a status and milliseconds', async () => {
    const r = await runBin([`${site.origin}/`, "--verbose"]);
    expect(r.stderr).toMatch(/^debug GET http:\/\/127\.0\.0\.1:\d+\/ 200 \d+ms$/m);
  });

  it("--quiet --verbose: exit 2 with the one-line message", async () => {
    const r = await runBin([`${site.origin}/`, "--quiet", "--verbose"]);
    expect(r.status).toBe(2);
    expect(r.stderr.split("\n")[0]).toBe("Choose --quiet or --verbose, not both.");
  });
});

describe("logger: promise test", () => {
  it("with SANITY_TOKEN set, a --verbose run prints no marker and no authorization on either stream", async () => {
    const marker = "MARKER_SANITY_77de";
    const r = await runBin([`${site.origin}/?token=${marker}`, "--verbose"], {
      SANITY_TOKEN: marker,
    });
    for (const out of [r.stdout, r.stderr]) {
      expect(out).not.toContain(marker);
      expect(out.toLowerCase()).not.toContain("authorization");
    }
  });
});

describe("logger: edge cases", () => {
  it("stderr closed early: the EPIPE is swallowed and the exit code is still correct", async () => {
    const child = spawn(
      process.execPath,
      [bin, `${site.origin}/`, "--verbose", "--allow-private"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // Like runBin: a CI runner's CI variable would turn on --ci and change the exit code.
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !["CI", "GITHUB_ACTIONS"].includes(k)),
        ),
      },
    );
    child.stderr.destroy();
    child.stdout.resume();
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
  });

  it("stderr is not a TTY: no ANSI codes and no carriage-return spinner, only whole lines", async () => {
    const r = await runBin([`${site.origin}/`]);
    expect(r.stderr).not.toContain("\u001b[");
    expect(r.stderr).not.toContain("\r");
  });

  it("NO_COLOR=1 with colour forced on a stream: plain text", async () => {
    const r = await runBin([`${site.origin}/`], { NO_COLOR: "1", FORCE_COLOR: "1" });
    expect(r.stderr).not.toContain("\u001b[");
  });

  it("a problem found before the logger exists (bad flag) still goes to stderr through formatError", async () => {
    const r = await runBin(["--nope"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--nope");
  });
});
