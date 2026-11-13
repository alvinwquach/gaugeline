import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  emptyBlocked,
  resultSchema,
  type RenderRequest,
  type RenderedPage,
  type Renderer,
  type Transport,
} from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../fixtures/src/index.js";
import { staticSite } from "../../../testkit/src/index.js";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";

/**
 * `gaugeline <site> --renderer playwright --attribution` (PERF-02), in memory: the invented Corner Pantry shop
 * answers from its fixture folder and the browser is a stand-in that answers each load with invented timings
 * (the real browser is in packages/renderer/src/__tests__/variants.e2e.test.ts).
 */
const HOST = "corner-pantry.example";
const HOME = `https://${HOST}/`;
const STORY = "Corner Pantry sells bread, jam and tea. ".repeat(8);

function timings(variant: RenderRequest["variant"], sample: number) {
  if (variant?.javaScript === false) return { lcpMs: 150, scriptsRefused: 0 };
  if (variant?.blockThirdPartyScripts) return { lcpMs: 1620, tbtMs: 110, scriptsRefused: 2 };
  if (variant?.reducedMotion) return { lcpMs: 940, tbtMs: 840, scriptsRefused: 0 };
  return { lcpMs: sample === 0 ? 1610 : 1650, tbtMs: sample === 0 ? 830 : 850, scriptsRefused: 0 };
}

function fakeRenderer(log: RenderRequest[]): Renderer {
  return {
    name: "playwright",
    availability: () =>
      Promise.resolve({ kind: "available", detail: "Chromium at /fake (system)" }),
    render: (request) => {
      log.push(request);
      const page: RenderedPage = {
        kind: "rendered",
        finalUrl: HOME,
        status: 200,
        title: "Corner Pantry" as never,
        text: STORY as never,
        requests: [],
        blocked: emptyBlocked(),
        totals: { requests: 1, bytes: 1 },
        truncated: [],
        ...(request.measure
          ? { performance: timings(request.variant, request.measure.sample) }
          : {}),
      };
      return Promise.resolve(page);
    },
    close: () => Promise.resolve(),
  };
}

async function run(argv: string[]) {
  const log: RenderRequest[] = [];
  const others: Transport = () =>
    Promise.resolve({ status: 404, headers: {}, body: Readable.from([Buffer.from("not found")]) });
  const site = staticSite(HOST, join(SITES_DIR, "old-theme-shop"), others);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    {
      cwd: mkdtempSync(join(tmpdir(), "gaugeline-attribution-")),
      fetcher: { transport: site },
      renderer: () => fakeRenderer(log),
    } as never,
  );
  return { code, out: out.join(""), err: err.join(""), log };
}

const ours = (text: string) => {
  const result = resultSchema.parse(JSON.parse(text));
  return {
    findings: result.findings.filter((f) => f.checkId === "perf-attribution"),
    couldNotCheck: result.couldNotCheck.filter((c) => c.id === "perf-attribution"),
  };
};

describe("gaugeline check --renderer playwright --attribution: end to end (in memory)", () => {
  it("names the change behind each number as low-severity advice", async () => {
    const r = await run([
      HOST,
      "--renderer",
      "playwright",
      "--attribution",
      "--json",
      "--no-open",
      "--quiet",
    ]);
    expect(r.code).toBe(EXIT.ok);
    const got = ours(r.out);
    expect(got.findings.map((f) => f.severity)).toEqual(["low", "low", "low"]);
    expect(got.findings.map((f) => f.evidence.slice(0, 70))).toEqual([
      "With reduced motion forced, Largest Contentful Paint went from 1630 ms",
      "With JavaScript off, Largest Contentful Paint went from 1630 ms to 150",
      "With scripts from other sites blocked, total blocking time went from 8",
    ]);
  });

  it("loads the page five times in the renderer: twice as it is, then once with each change", async () => {
    const r = await run([
      HOST,
      "--renderer",
      "playwright",
      "--attribution",
      "--json",
      "--no-open",
      "--quiet",
    ]);
    expect(r.log.map((q) => [q.variant ?? null, q.measure?.sample ?? null])).toEqual([
      [null, 0],
      [null, 1],
      [{ reducedMotion: true }, 0],
      [{ javaScript: false }, 0],
      [{ blockThirdPartyScripts: true }, 0],
    ]);
    expect(r.log.every((q) => q.url === HOME)).toBe(true);
  });

  it("says Speed Index was not measured, and is otherwise a low finding that never fails --ci", async () => {
    const r = await run([
      HOST,
      "--renderer",
      "playwright",
      "--attribution",
      "--ci",
      "--json",
      "--no-open",
      "--quiet",
    ]);
    expect(r.code).toBe(EXIT.ok);
    expect(ours(r.out).couldNotCheck.map((c) => c.reason)).toEqual([
      expect.stringContaining("Total blocking time is not measured with JavaScript off"),
      expect.stringContaining("Speed Index was not measured"),
    ]);
  });

  it("is not in the run without --attribution: no check, and nothing is measured or varied", async () => {
    const r = await run([HOST, "--renderer", "playwright", "--json", "--no-open", "--quiet"]);
    expect(ours(r.out)).toEqual({ findings: [], couldNotCheck: [] });
    expect(r.log.some((q) => q.measure || q.variant)).toBe(false);
  });

  it("without --renderer it says it needs a browser, and loads nothing", async () => {
    const r = await run([HOST, "--attribution", "--json", "--no-open", "--quiet"]);
    expect(r.log).toEqual([]);
    const got = ours(r.out);
    expect(got.findings).toEqual([]);
    expect(got.couldNotCheck[0]?.reason).toContain("--renderer playwright");
  });
});

describe("--attribution: parsing, help and flags", () => {
  it("parses --attribution on the page check, off by default", () => {
    const a = parseCliArgs([HOST, "--attribution"], {});
    expect(a.kind === "run" && a.attribution).toBe(true);
    const b = parseCliArgs([HOST], {});
    expect(b.kind === "run" && b.attribution).toBe(false);
  });

  it("is a boolean on the page check, and in --help", () => {
    const f = FLAGS.find((x) => x.name === "attribution");
    expect(f?.type).toBe("boolean");
    expect(f?.commands).toEqual(["check"]);
    expect(HELP[""]).toContain("--attribution");
  });
});

/**
 * docs/guides/speed-attribution.md shows what `gaugeline corner-pantry.example --renderer playwright
 * --attribution` prints. The browser here is the stand-in above, so the page's numbers are invented: every
 * line of the page's Output block must be in what the command printed.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/speed-attribution.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const block = (title: string): string[] =>
  (
    new RegExp('```[a-z]* title="?' + title + '[^"\\n]*"?\\n([\\s\\S]*?)\\n```').exec(page)?.[1] ??
    ""
  )
    .split("\n")
    .filter((l) => l !== "");

describe("docs/guides/speed-attribution.md: the command it shows", () => {
  it("prints the lines the page shows", async () => {
    const r = await run([HOST, "--renderer", "playwright", "--attribution", "--no-open"]);
    const printed = r.out.split("\n");
    const shown = block("Output");
    expect(shown.length).toBeGreaterThan(4);
    for (const line of shown) expect(printed, line).toContain(line);
  });

  it("names the flags, the check id and the limits", () => {
    for (const word of [
      "--attribution",
      "--renderer playwright",
      "perf-attribution",
      "Speed Index",
    ])
      expect(page).toContain(word);
  });
});
