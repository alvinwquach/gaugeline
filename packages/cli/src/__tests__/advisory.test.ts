import { withFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { html, worldTransport, type SiteDef } from "../../../core/src/advisory/__tests__/world.js";
import { parseCliArgs } from "../args.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const SITE = "harbour-bar.example";
const CHUNK = "/_next/static/chunks/main-app-3f2a.js";

const next = (version: string): SiteDef => ({
  headers: { server: "Vercel", "x-vercel-id": "lhr1::abc" },
  routes: {
    "/": html({ scripts: [CHUNK] }),
    [CHUNK]: { type: "text/javascript", body: `window.next={version:"${version}",appDir:!0}` },
  },
});

async function run(argv: string[], site: SiteDef = next("15.1.0"), osv: { down?: boolean } = {}) {
  const world = worldTransport({ [SITE]: site }, osv);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["advisory", ...argv],
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
      now: () => new Date("2026-11-11T09:00:00.000Z"),
    },
    { fetcher: { transport: world.transport } },
  );
  return { code, out: out.join(""), err: err.join(""), world };
}

describe("gaugeline advisory: arguments", () => {
  const parse = (...a: string[]) => parseCliArgs(["advisory", ...a], {});

  it("takes a site and an advisory, and the options", () => {
    expect(parse(SITE, "CVE-2026-00123")).toMatchObject({
      kind: "advisory",
      address: `https://${SITE}/`,
      spec: "CVE-2026-00123",
      packages: [],
      hosts: [],
      json: false,
      note: false,
    });
    expect(
      parse(
        SITE,
        "CVE-2026-00123",
        "--package",
        "next@<15.2.3",
        "--package",
        "react@<19",
        "--host",
        "Old.Harbour-Bar.example",
        "--dns",
        "--json",
        "--ci",
      ),
    ).toMatchObject({
      packages: ["next@<15.2.3", "react@<19"],
      hosts: ["old.harbour-bar.example"],
      dns: true,
      json: true,
      ci: true,
    });
  });

  it("is exit 2 with a hint for a missing advisory, a third word, a bad host or --note with --json", () => {
    for (const bad of [
      parse(SITE),
      parse(SITE, "a", "b"),
      parse(SITE, "CVE-2026-1", "--host", "not a host"),
      parse(SITE, "CVE-2026-1", "--note", "--json"),
      parse("http://", "CVE-2026-1"),
    ])
      expect(bad).toMatchObject({ kind: "error", hint: expect.any(String) });
  });

  it("its flags are in --help and in the flag table, the same list", () => {
    const names = flagsFor(FLAGS, "advisory").map((f) => `--${f.name}`);
    for (const n of ["--package", "--host", "--note", "--json", "--dns", "--ci", "--allow-private"])
      expect(names).toContain(n);
    for (const n of names) expect(HELP.advisory).toContain(n);
    expect(HELP.advisory).toMatch(/never says a\s+site is safe/);
  });
});

describe("gaugeline advisory: what it prints and returns", () => {
  it("terminal: the answer first, the evidence, check inside, and exit 0", async () => {
    const r = await run([SITE, "CVE-2026-00123"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toMatch(/^Likely affected: Next\.js 15\.1\.0/);
    expect(r.out).toMatch(/Check inside/);
    expect(r.out).toMatch(/fixed|15\.2\.3/);
    expect(r.err).toBe("");
  });

  it("--ci: likely-affected is exit 1; the others are 0", async () => {
    expect((await run([SITE, "CVE-2026-00123", "--ci"])).code).toBe(1);
    expect((await run([SITE, "CVE-2026-00123", "--ci"], next("16.2.1"))).code).toBe(0);
  });

  it("--json prints the data and nothing else, with its own schemaVersion", async () => {
    const r = await run([SITE, "CVE-2026-00123", "--json"]);
    const data = JSON.parse(r.out) as { schemaVersion: number; verdict: string };
    expect(data).toMatchObject({ schemaVersion: 1, verdict: "likely-affected" });
    expect(r.out.endsWith("\n")).toBe(true);
  });

  it("--note prints the client's note", async () => {
    const r = await run([SITE, "CVE-2026-00123", "--note"]);
    expect(r.out).toMatch(/^Subject: Are we affected by CVE-2026-00123\?/);
  });

  it("package@range asks OSV nothing; an id with OSV down is exit 2 with the way out, nothing printed to stdout", async () => {
    const direct = await run([SITE, "next@>=15.0.0 <15.2.3"]);
    expect(direct.code).toBe(0);
    expect(direct.world.osvSeen).toEqual([]);
    const down = await run([SITE, "CVE-2026-00123"], next("15.1.0"), { down: true });
    expect(down.code).toBe(2);
    expect(down.out).toBe("");
    expect(down.err).toMatch(/OSV/);
    expect(down.err).toMatch(/--package/);
    const fallback = await run(
      [SITE, "CVE-2026-00123", "--package", "next@>=15.0.0 <15.2.3"],
      next("15.1.0"),
      { down: true },
    );
    expect(fallback.code).toBe(0);
  });

  it("a range that is not a range is exit 2 before any request", async () => {
    const r = await run([SITE, "next@banana"]);
    expect(r.code).toBe(2);
    expect(r.world.seen).toEqual([]);
  });

  it("only GET and HEAD are sent, to the site and to api.osv.dev", async () => {
    const r = await run([SITE, "CVE-2026-00123"]);
    expect(r.world.seen.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    expect(r.world.osvSeen.every((q) => q.method === "GET")).toBe(true);
  });
});

describe("gaugeline advisory: the built command against the invented fixture sites", () => {
  const NEXT_RANGE = "next@>=15.0.0 <15.2.3";
  const WP_RANGE = "wp-plugin:easy-booking@<2.4.0";
  const verdictOf = async (fixture: string, spec: string) =>
    withFixture(fixture, async (site) => {
      const r = await runBin(["advisory", `${site.origin}/`, spec, "--json"]);
      expect(r.status, r.stderr).toBe(0);
      // a read-only run: nothing but GET
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
      return JSON.parse(r.stdout) as { verdict: string; evidence: string[] };
    });

  it("a Next.js site inside the range, one outside and one whose version cannot be read", async () => {
    expect((await verdictOf("advisory-next-affected", NEXT_RANGE)).verdict).toBe("likely-affected");
    expect((await verdictOf("advisory-next-fixed", NEXT_RANGE)).verdict).toBe(
      "likely-not-affected",
    );
    expect((await verdictOf("advisory-next-unreadable", NEXT_RANGE)).verdict).toBe("cannot-tell");
  });

  it("a WordPress site with an affected plugin version in its served assets", async () => {
    const r = await verdictOf("advisory-wordpress-plugin", WP_RANGE);
    expect(r.verdict).toBe("likely-affected");
    expect(r.evidence.join("\n")).toMatch(/easy-booking 2\.1\.3/);
    // the gallery plugin's files carry WordPress's own number: not read as the plugin's version
    expect(
      (await verdictOf("advisory-wordpress-plugin", "wp-plugin:gallery-lite@<9.0.0")).verdict,
    ).toBe("cannot-tell");
  });

  it("a site behind a CDN that strips headers is cannot-tell, with the reason", async () => {
    const r = await verdictOf("advisory-cdn-stripped", NEXT_RANGE);
    expect(r.verdict).toBe("cannot-tell");
    expect(r.evidence.join("\n")).toMatch(/CloudFront is in front of the site/);
  });
});
