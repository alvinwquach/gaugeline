import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CheckRegistry,
  defineCheck,
  emptyBlocked,
  type PageSnapshot,
  type RenderResult,
  type Renderer,
  type Transport,
} from "@gaugeline/core";
import type { createPlaywrightRenderer as createAdapter } from "@gaugeline/renderer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  html,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { EXIT, main } from "../main.js";
import { startRenderer } from "../renderer.js";

/**
 * `--renderer playwright` (ADR-0009, accepted in part): off unless named, one name, and nothing is loaded
 * for a run that does not name it.
 */

const loaded = vi.hoisted(() => ({ adapter: 0, driver: 0 }));
vi.mock("@gaugeline/renderer", () => {
  loaded.adapter += 1;
  return {
    createPlaywrightRenderer: () => ({
      name: "playwright",
      availability: () =>
        Promise.resolve({
          kind: "could-not-check",
          reason: "no browser here",
          hint: "install one",
        }),
      render: () => Promise.resolve({ kind: "could-not-check", reason: "no browser here" }),
      close: () => Promise.resolve(),
    }),
  };
});
vi.mock("playwright-core", () => {
  loaded.driver += 1;
  return { chromium: {} };
});

let site: FixtureServer;
beforeAll(async () => {
  site = await startServer({
    "/": html(
      "<html><head><title>Fernhill Taproom</title></head><body><h1>Pints</h1></body></html>",
    ),
  });
});
afterAll(async () => {
  await site.close();
});

const page = (title: string): RenderResult => ({
  kind: "rendered",
  finalUrl: `${site.origin}/`,
  status: 200,
  title: title as never,
  requests: [],
  blocked: emptyBlocked(),
  totals: { requests: 1, bytes: 10 },
  truncated: [],
});

/** A check that asks for the rendered page, if there is a way to, and says what it got. */
function probe(seen: { render?: boolean; result?: RenderResult }) {
  return defineCheck<PageSnapshot>({
    id: "render-probe",
    area: "Visitors",
    severity: "low",
    title: "Render probe",
    what: "w",
    why: "y",
    fix: "f",
    tech: "t",
    size: "S",
    done: "d",
    estimateChanges: "e",
    run: async (_page, ctx) => {
      seen.render = ctx.render !== undefined;
      if (ctx.render) seen.result = await ctx.render();
      return [];
    },
  });
}

async function run(
  args: string[],
  seen: Parameters<typeof probe>[0],
  env: Record<string, string> = {},
  create?: Parameters<typeof main>[2],
) {
  let out = "";
  let err = "";
  const registry = new CheckRegistry().register(probe(seen));
  const code = await main(
    [site.origin, "--allow-private", "--no-open", ...args],
    {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
      env,
    },
    { registry, ...create },
  );
  return { code, out, err };
}

describe("--renderer: the flag", () => {
  it("is off by default and names one renderer", () => {
    expect(parseCliArgs(["example.com"])).toMatchObject({ kind: "run" });
    const parsed = parseCliArgs(["example.com", "--renderer", "playwright"]);
    expect(parsed).toMatchObject({ kind: "run", renderer: "playwright" });
    expect(parseCliArgs(["example.com"])).not.toHaveProperty("renderer");
  });

  it.each(["firecrawl", "hosted", "chromium", ""])(
    "refuses %j: only playwright is accepted",
    (name) => {
      const parsed = parseCliArgs(["example.com", "--renderer", name]);
      expect(parsed).toMatchObject({ kind: "error" });
      if (parsed.kind === "error") expect(parsed.message).toContain("playwright");
    },
  );

  it("is a page-check flag and nothing else's", () => {
    const flag = FLAGS.find((f) => f.name === "renderer");
    expect(flag).toMatchObject({ type: "string", commands: ["check"] });
    expect(flag?.env).toBeUndefined();
    expect(parseCliArgs(["launch", "example.com", "--renderer", "playwright"])).toMatchObject({
      kind: "error",
    });
  });
});

describe("--renderer: a run that does not name it loads nothing", () => {
  it("never imports the adapter or the driver, and gives the checks no render", async () => {
    const seen: Parameters<typeof probe>[0] = {};
    const { code } = await run([], seen);
    expect(code).toBe(EXIT.ok);
    expect(seen.render).toBe(false);
    expect(loaded).toEqual({ adapter: 0, driver: 0 });
  });

  it("only the renderer file of the CLI imports the adapter, and only by a dynamic import", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "node_modules" && name !== "dist" && name !== "__tests__") walk(path);
        } else if (/\.tsx?$/.test(name)) sources.push(path);
      }
    };
    for (const pkg of readdirSync(root)) walk(join(root, pkg, "src") + sep);
    const rel = (p: string) => relative(root, p).split(sep).join("/");
    const importing = (needle: RegExp) =>
      sources.filter((f) => needle.test(readFileSync(f, "utf8"))).map(rel);
    // No static import of the driver anywhere but the adapter, and none of the adapter in the CLI.
    expect(
      importing(/from\s+["']playwright-core["']/).filter(
        (f) => !f.endsWith("renderer/src/playwright.ts"),
      ),
    ).toEqual([]);
    expect(importing(/import\s+(?!type\b)[^;]*from\s+["']@gaugeline\/renderer["']/)).toEqual([]);
    expect(importing(/import\(\s*["']@gaugeline\/renderer["']\s*\)/)).toEqual([
      "cli/src/renderer.ts",
    ]);
    expect(importing(/import\(\s*["']playwright-core["']\s*\)/)).toEqual([
      "renderer/src/playwright.ts",
    ]);
    // Core imports no browser.
    expect(
      importing(
        /(?:from\s+|import\(\s*)["'](?:playwright|playwright-core|@playwright\/[a-z-]+)["']/,
      ).filter((f) => f.startsWith("core/")),
    ).toEqual([]);
  });
});

describe("--renderer playwright: a run that names it", () => {
  it("hands the checks the renderer and closes it when the run ends", async () => {
    let closed = 0;
    const renderer: Renderer = {
      name: "playwright",
      availability: () =>
        Promise.resolve({ kind: "available", detail: "Chromium at /fake (system)" }),
      render: () => Promise.resolve(page("Fernhill")),
      close: () => ((closed += 1), Promise.resolve()),
    };
    const seen: Parameters<typeof probe>[0] = {};
    const { code, err } = await run(
      ["--renderer", "playwright", "--verbose"],
      seen,
      {},
      {
        renderer: () => renderer,
      },
    );
    expect(code).toBe(EXIT.ok);
    expect(seen.render).toBe(true);
    expect(seen.result).toMatchObject({ kind: "rendered", title: "Fernhill" });
    expect(closed).toBe(1);
    expect(err).toContain("rendering: Chromium at /fake (system)");
  });

  it("with no browser: says so, how to install one, and ends the run cleanly with could-not-check", async () => {
    const seen: Parameters<typeof probe>[0] = {};
    // The adapter itself, over a browser path that is not there: the real finder, nothing mocked but the driver.
    const { createPlaywrightRenderer } = await vi.importActual<{
      createPlaywrightRenderer: typeof createAdapter;
    }>("@gaugeline/renderer");
    const { code, err } = await run(
      ["--renderer", "playwright"],
      seen,
      { GAUGELINE_BROWSER_PATH: "/nowhere/chrome" },
      {
        renderer: ({ transport }) =>
          createPlaywrightRenderer({
            transport,
            env: { GAUGELINE_BROWSER_PATH: "/nowhere/chrome" },
            loadDriver: () =>
              Promise.resolve({ chromium: { executablePath: () => "/nowhere/pw" } } as never),
          }),
      },
    );
    expect(code).toBe(EXIT.ok);
    expect(err).toContain("rendering is on, but");
    expect(err).toContain("/nowhere/chrome");
    expect(err).toContain("npx playwright install chromium");
    expect(err).toContain("never downloads");
    expect(seen.render).toBe(true);
    expect(seen.result).toMatchObject({ kind: "could-not-check" });
  });

  it("loads the adapter on demand and reports a renderer that cannot start", async () => {
    const seen: Parameters<typeof probe>[0] = {};
    const { code, err } = await run(["--renderer", "playwright"], seen);
    expect(code).toBe(EXIT.ok);
    expect(loaded.adapter).toBe(1);
    expect(loaded.driver).toBe(0);
    expect(err).toContain("no browser here");
    expect(err).toContain("install one");
    expect(seen.result).toMatchObject({ kind: "could-not-check", reason: "no browser here" });
  });

  it("prints no hint under --quiet", async () => {
    const { err } = await run(["--renderer", "playwright", "--quiet"], {});
    expect(err).not.toContain("install one");
  });
});

describe("startRenderer: the network rules of the real transport", () => {
  let other: FixtureServer;
  beforeAll(async () => {
    other = await startServer({ "/": html("<html><title>Other</title></html>") });
  });
  afterAll(async () => {
    await other.close();
  });

  /** The transport startRenderer builds, with no replacement, as the renderer's adapter would get it. */
  async function transportFor(address: string, allowPrivate: boolean): Promise<Transport> {
    let got: Transport | undefined;
    await startRenderer({
      name: "playwright",
      address,
      allowPrivate,
      env: {},
      create: ({ transport }) => {
        got = transport;
        return {
          name: "playwright",
          availability: () => Promise.resolve({ kind: "available", detail: "fake" }),
          render: () => Promise.resolve(page("x")),
          close: () => Promise.resolve(),
        };
      },
    });
    if (!got) throw new Error("no transport");
    return got;
  }
  const ask = (t: Transport, url: string) =>
    t(new URL(url), { method: "GET", headers: {}, timeoutMs: 5000 }).then((r) => {
      r.body.destroy();
      return r.status;
    });

  it("refuses a loopback address without --allow-private", async () => {
    const t = await transportFor(`${site.origin}/`, false);
    await expect(ask(t, `${site.origin}/`)).rejects.toMatchObject({ reason: "blocked-address" });
  });

  it("with --allow-private reaches the address typed, and no other private address", async () => {
    const t = await transportFor(`${site.origin}/`, true);
    await expect(ask(t, `${site.origin}/`)).resolves.toBe(200);
    // Another loopback port is a different host and port: refused, as the fetcher refuses a redirect to it.
    await expect(ask(t, `${other.origin}/`)).rejects.toMatchObject({
      reason: "private-address-refused",
    });
    await expect(ask(t, "http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      reason: "private-address-refused",
    });
  });
});

describe("startRenderer", () => {
  it("gives the renderer the fetcher's network rules: private addresses only on the address typed", async () => {
    let seen: unknown;
    const started = await startRenderer({
      name: "playwright",
      address: "http://127.0.0.1:4000/",
      allowPrivate: true,
      env: {},
      create: ({ transport }) => {
        seen = transport;
        return {
          name: "playwright",
          availability: () => Promise.resolve({ kind: "available", detail: "fake" }),
          render: () => Promise.resolve(page("x")),
          close: () => Promise.resolve(),
        };
      },
    });
    expect(typeof seen).toBe("function");
    expect(started.source.renderer?.name).toBe("playwright");
    await started.close();
  });

  it("uses the transport the fetcher was given, so a test or a recording sees the same requests", async () => {
    const transport = vi.fn();
    let got: unknown;
    await startRenderer({
      name: "playwright",
      address: "https://site.example/",
      allowPrivate: false,
      transport,
      env: {},
      create: (o) => {
        got = o.transport;
        return {
          name: "playwright",
          availability: () => Promise.resolve({ kind: "available", detail: "fake" }),
          render: () => Promise.resolve(page("x")),
          close: () => Promise.resolve(),
        };
      },
    });
    expect(got).toBe(transport);
  });
});
