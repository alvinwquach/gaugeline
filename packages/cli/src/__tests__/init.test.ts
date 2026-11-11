import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { html, worldTransport, type SiteDef } from "../../../core/src/advisory/__tests__/world.js";
import { parseCliArgs } from "../args.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { readAdaptersConfig, readHandoffConfig } from "../schema-config.js";

const SITE = "harbour-bar.example";

const bar: SiteDef = {
  headers: { "x-powered-by": "WP Engine" },
  routes: {
    "/": html({
      head: `<meta name="generator" content="WordPress 6.6">`,
      body: `<nav><a href="/book/">Book</a></nav><img src="https://cdn.sanity.io/images/abc123xy/production/a-1x1.jpg" alt="">`,
    }),
    "/book/": html({
      body: `<form action="https://formspree.io/f/xharbour1" method="post"><input name="email"></form>`,
    }),
  },
};

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-init-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function run(argv: string[], site: SiteDef = bar) {
  const world = worldTransport({ [SITE]: site });
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["init", ...argv],
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    { fetcher: { transport: world.transport }, cwd: dir },
  );
  return { code, out: out.join(""), err: err.join(""), world };
}

const files = (): string[] => readdirSync(dir).sort();

describe("gaugeline init: arguments", () => {
  const parse = (...a: string[]) => parseCliArgs(["init", ...a], {});

  it("takes one site and the options", () => {
    expect(parse(SITE)).toMatchObject({
      kind: "init",
      address: `https://${SITE}/`,
      dryRun: false,
      force: false,
      dns: false,
    });
    expect(parse(SITE, "--dry-run", "--force", "--dns")).toMatchObject({
      dryRun: true,
      force: true,
      dns: true,
    });
  });

  it("is exit 2 with a hint for no site, two sites or a bad address", () => {
    for (const bad of [parse(), parse(SITE, "other.example"), parse("http://")])
      expect(bad).toMatchObject({ kind: "error", hint: expect.any(String) });
  });

  it("its flags are in --help and in the flag table, the same list", () => {
    const names = flagsFor(FLAGS, "init").map((f) => `--${f.name}`);
    for (const n of ["--dry-run", "--force", "--dns", "--allow-private"])
      expect(names).toContain(n);
    for (const n of names) expect(HELP.init).toContain(n);
    expect(HELP.init).toMatch(/never writes a\s+key/);
  });
});

describe("gaugeline init: --dry-run", () => {
  it("prints what it found and every file, and writes nothing", async () => {
    const r = await run([SITE, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("WordPress");
    expect(r.out).toContain("Formspree");
    expect(r.out).toContain("--- gaugeline.adapters.json ---");
    expect(r.out).toContain("--- gaugeline.init.md ---");
    expect(r.out).toContain("WORDPRESS_APP_PASSWORD");
    expect(files()).toEqual([]);
  });

  it("is the same output twice", async () => {
    expect((await run([SITE, "--dry-run"])).out).toBe((await run([SITE, "--dry-run"])).out);
  });
});

describe("gaugeline init: writing", () => {
  it("writes the settings files into the working folder, prints every path, and the files load", async () => {
    const r = await run([SITE]);
    expect(r.code).toBe(0);
    expect(files()).toEqual([
      "gaugeline.adapters.json",
      "gaugeline.handoff.json",
      "gaugeline.init.md",
    ]);
    for (const name of files()) expect(r.out).toContain(join(dir, name));
    // The files are the ones the other commands read: the same schema accepts them.
    expect(readAdaptersConfig(dir)?.adapters.map((a) => a.id)).toEqual(["sanity", "wordpress"]);
    expect(readHandoffConfig(dir)).toEqual({ sanity: { projectId: "abc123xy" } });
    const notes = readFileSync(join(dir, "gaugeline.init.md"), "utf8");
    expect(notes).toContain('generator tag "WordPress 6.6"');
    expect(notes).toContain("WORDPRESS_APP_PASSWORD");
  });

  it("writes no key, no secret and no value for a variable", async () => {
    await run([SITE]);
    for (const name of files()) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text, name).not.toMatch(/[A-Z][A-Z_]{3,}\s*=\s*\S/);
      if (name.endsWith(".json")) expect(text, name).not.toMatch(/token|password|secret/i);
    }
  });

  it("asks the site with GET only, for its pages and nothing it was not linked to", async () => {
    const r = await run([SITE]);
    expect(r.world.seen.length).toBeGreaterThan(0);
    for (const q of r.world.seen) expect(["GET", "HEAD"]).toContain(q.method);
    expect(r.world.seen.map((q) => new URL(q.url).pathname).sort()).toEqual(["/", "/book/"]);
  });

  it("a site with nothing detectable gets the minimal config", async () => {
    const r = await run([SITE], { routes: { "/": html() } });
    expect(r.code).toBe(0);
    expect(files()).toEqual(["gaugeline.adapters.json", "gaugeline.init.md"]);
    expect(JSON.parse(readFileSync(join(dir, "gaugeline.adapters.json"), "utf8"))).toEqual({
      adapters: [{ id: "sitemap-feed" }],
    });
    expect(r.out).toContain("Nothing it could name");
  });

  it("leaves an existing config alone: exit 2, nothing written, no request made", async () => {
    writeFileSync(join(dir, "gaugeline.adapters.json"), '{"adapters":[{"id":"sanity"}]}\n');
    const r = await run([SITE]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/already exists/);
    expect(r.err).toMatch(/--force/);
    expect(files()).toEqual(["gaugeline.adapters.json"]);
    expect(readFileSync(join(dir, "gaugeline.adapters.json"), "utf8")).toBe(
      '{"adapters":[{"id":"sanity"}]}\n',
    );
    expect(r.world.seen).toEqual([]);
  });

  it("an existing other file stops it too, and no file is half written", async () => {
    writeFileSync(join(dir, "gaugeline.handoff.json"), "{}\n");
    const r = await run([SITE]);
    expect(r.code).toBe(2);
    expect(files()).toEqual(["gaugeline.handoff.json"]);
  });

  it("--force replaces the files it writes", async () => {
    writeFileSync(join(dir, "gaugeline.adapters.json"), '{"adapters":[{"id":"sanity"}]}\n');
    const r = await run([SITE, "--force"]);
    expect(r.code).toBe(0);
    expect(readAdaptersConfig(dir)?.adapters.map((a) => a.id)).toEqual(["sanity", "wordpress"]);
  });

  it.skipIf(process.platform === "win32")(
    "--force never writes through a link or into a folder",
    async () => {
      mkdirSync(join(dir, "elsewhere"));
      symlinkSync(join(dir, "elsewhere"), join(dir, "gaugeline.adapters.json"));
      const r = await run([SITE, "--force"]);
      expect(r.code).toBe(2);
      expect(readdirSync(join(dir, "elsewhere"))).toEqual([]);
      expect(existsSync(join(dir, "gaugeline.init.md"))).toBe(false);
    },
  );

  it("a site that cannot be reached is exit 2 and writes nothing", async () => {
    const r = await run(["nowhere.example"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/could not be reached/);
    expect(files()).toEqual([]);
  });
});
