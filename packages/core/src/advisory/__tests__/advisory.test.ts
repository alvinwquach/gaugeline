import { describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import { createFetcher } from "../../fetcher.js";
import { checkAdvisory, type AdvisoryOptions } from "../run.js";
import { renderNote, renderTerminal } from "../render.js";
import { html, worldTransport, type SiteDef } from "./world.js";

const NOW = () => new Date("2026-11-11T09:00:00.000Z");
const BAR = "harbour-bar.example";
const CHUNK = "/_next/static/chunks/main-app-3f2a.js";

const next = (version: string | null, headers: Record<string, string> = {}): SiteDef => ({
  headers: { server: "Vercel", "x-vercel-id": "lhr1::abc", ...headers },
  routes: {
    "/": html({ scripts: [CHUNK] }),
    [CHUNK]: {
      type: "text/javascript",
      body: version ? `window.next={version:"${version}",appDir:!0}` : "console.log(1)",
    },
  },
});

const wordpress = (plugin: string | null): SiteDef => ({
  headers: { server: "nginx", "x-powered-by": "PHP/8.1.27" },
  routes: {
    "/": html({
      head: '<meta name="generator" content="WordPress 6.4.2">',
      scripts: [
        "/wp-content/themes/harbour/js/t.js?ver=1.0.4",
        ...(plugin ? [`/wp-content/plugins/easy-booking/js/app.js?ver=${plugin}`] : []),
      ],
    }),
  },
});

async function run(
  sites: Record<string, SiteDef>,
  spec: string,
  over: Partial<AdvisoryOptions> = {},
  osv: { down?: boolean; garbage?: boolean } = {},
  address = `https://${BAR}/`,
) {
  const world = worldTransport(sites, osv);
  const result = await checkAdvisory({
    fetcher: createFetcher({ transport: world.transport }),
    address,
    spec,
    now: NOW,
    ...over,
  });
  return { result, world };
}

const text = (r: { evidence: string[] }) => r.evidence.join("\n");

describe("a Next.js site inside, outside and unreadable (advisory resolved through OSV)", () => {
  it("inside the affected range: likely-affected, with the version, the range and the fix", async () => {
    const { result, world } = await run({ [BAR]: next("15.1.0") }, "CVE-2026-00123");
    expect(result.verdict).toBe("likely-affected");
    expect(text(result)).toMatch(/served by Vercel/);
    expect(text(result)).toMatch(
      /Next\.js 15\.1\.0 .*window\.next\.version in the script main-app-3f2a\.js.*inside the affected versions >=15\.0\.0 <15\.2\.3/,
    );
    expect(result.components[0]).toMatchObject({
      name: "next",
      verdict: "likely-affected",
      fixedIn: "15.2.3",
    });
    expect(result.advisory).toMatchObject({ id: "CVE-2026-00123", source: "osv" });
    expect(result.checkInside.join("\n")).toMatch(/lockfile/);
    // one GET of OSV, nothing else sent anywhere
    expect(world.osvSeen).toEqual([
      { method: "GET", url: "https://api.osv.dev/v1/vulns/CVE-2026-00123" },
    ]);
    expect(world.seen.every((r) => r.method === "GET")).toBe(true);
  });

  it("outside the range: likely-not-affected, saying the version is outside, never 'safe'", async () => {
    const { result } = await run({ [BAR]: next("16.2.1") }, "GHSA-abcd-2345-wxyz");
    expect(result.verdict).toBe("likely-not-affected");
    expect(text(result)).toMatch(
      /Next\.js 16\.2\.1 .*outside the affected versions >=15\.0\.0 <15\.2\.3/,
    );
  });

  it("the version cannot be read: cannot-tell, and it says what was seen and what is missing", async () => {
    const { result } = await run({ [BAR]: next(null) }, "CVE-2026-00123");
    expect(result.verdict).toBe("cannot-tell");
    expect(text(result)).toMatch(/Next\.js is in use .*but its version could not be read/);
    expect(result.checkInside.join("\n")).toMatch(/package-lock|lockfile/);
  });

  it("a pre-release before the fix is affected; the fix itself is not", async () => {
    expect(
      (await run({ [BAR]: next("15.2.3-canary.1") }, "next@>=15.0.0 <15.2.3")).result.verdict,
    ).toBe("likely-affected");
    expect((await run({ [BAR]: next("15.2.3") }, "next@>=15.0.0 <15.2.3")).result.verdict).toBe(
      "likely-not-affected",
    );
  });
});

describe("a package and range typed directly, and OSV unreachable", () => {
  it("package@range never asks OSV", async () => {
    const { result, world } = await run({ [BAR]: next("15.1.0") }, "next@>=15.0.0 <15.2.3");
    expect(result.verdict).toBe("likely-affected");
    expect(result.advisory.source).toBe("given");
    expect(world.osvSeen).toEqual([]);
  });

  it("an id with OSV unreachable stops with the way out: pass the package and range", async () => {
    const attempt = run({ [BAR]: next("15.1.0") }, "CVE-2026-00123", {}, { down: true });
    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toMatchObject({
      hint: expect.stringMatching(/package@range|--package/),
    });
  });

  it("an id and --package: the id is the label, OSV is not asked, and it works while OSV is down", async () => {
    const { result, world } = await run(
      { [BAR]: next("15.1.0") },
      "CVE-2026-00123",
      { packages: ["next@>=15.0.0 <15.2.3"] },
      { down: true },
    );
    expect(result.verdict).toBe("likely-affected");
    expect(result.advisory).toMatchObject({ id: "CVE-2026-00123", source: "given" });
    expect(world.osvSeen).toEqual([]);
  });

  it("an id OSV does not know says so, and names the way out", async () => {
    await expect(run({ [BAR]: next("15.1.0") }, "CVE-2026-09999")).rejects.toMatchObject({
      message: expect.stringMatching(/no advisory/i),
      hint: expect.stringMatching(/GHSA|package@range/),
    });
  });

  it("a withdrawn advisory gives no verdict from its ranges", async () => {
    const { result } = await run({ [BAR]: next("15.1.0") }, "GHSA-wdrn-2345-abcd");
    expect(result.verdict).toBe("cannot-tell");
    expect(result.advisory.withdrawn).toBe("2026-10-02T09:00:00Z");
    expect(text(result)).toMatch(/withdrawn/);
  });
});

describe("WordPress: a plugin in served assets", () => {
  it("an affected plugin version in the page's files: likely-affected, naming where", async () => {
    const { result } = await run({ [BAR]: wordpress("2.1.3") }, "CVE-2026-00456");
    expect(result.verdict).toBe("likely-affected");
    expect(text(result)).toMatch(
      /easy-booking 2\.1\.3 .*file addresses.*inside the affected versions <2\.4\.0/,
    );
    expect(result.components.find((c) => c.name === "easy-booking")?.fixedIn).toBe("2.4.0");
    // WordPress 6.4.2 is outside the core stretch the advisory lists
    expect(result.components.find((c) => c.name.includes("wordpress"))?.verdict).toBe(
      "likely-not-affected",
    );
  });

  it("a fixed plugin version is outside", async () => {
    const { result } = await run({ [BAR]: wordpress("2.4.0") }, "wp-plugin:easy-booking@<2.4.0");
    expect(result.verdict).toBe("likely-not-affected");
  });

  it("WordPress seen but the plugin's files are not on the page: cannot-tell, never a clean verdict", async () => {
    const { result } = await run({ [BAR]: wordpress(null) }, "wp-plugin:easy-booking@<2.4.0");
    expect(result.verdict).toBe("cannot-tell");
    expect(text(result)).toMatch(/no files of the plugin/i);
    expect(result.checkInside.join("\n")).toMatch(/wp plugin list|Plugins page/);
  });

  it("when the C-01 WordPress read is given it is used, and the answer changes", async () => {
    const { result } = await run({ [BAR]: wordpress(null) }, "wp-plugin:easy-booking@<2.4.0", {
      wordpress: { plugins: [{ slug: "easy-booking", version: "2.1.3" }] },
    });
    expect(result.verdict).toBe("likely-affected");
    expect(text(result)).toMatch(/WordPress read \(C-01\)/);
  });

  it.todo(
    "C-01 and F-07 merge: the CLI passes their WordPress read to checkAdvisory (the seam is `wordpress`)",
  );

  it("WordPress core by version", async () => {
    expect((await run({ [BAR]: wordpress("2.4.0") }, "wordpress@<6.4.3")).result.verdict).toBe(
      "likely-affected",
    );
    expect((await run({ [BAR]: wordpress("2.4.0") }, "wordpress@<6.4.2")).result.verdict).toBe(
      "likely-not-affected",
    );
  });
});

describe("a component the site does not use", () => {
  it("a Next.js advisory on a WordPress site: no sign of it from outside, with 'not seen' lines", async () => {
    const { result } = await run({ [BAR]: wordpress("2.1.3") }, "CVE-2026-00123");
    expect(result.verdict).toBe("likely-not-affected");
    expect(text(result)).toMatch(/No Next\.js seen on 1 hostname/);
    expect(text(result)).toMatch(/WordPress/);
    expect(renderTerminal(result)).toMatch(/no sign of the affected component from outside/i);
  });

  it("a composer package on a site with no PHP seen says so; with PHP in use it cannot tell", async () => {
    const off = await run({ [BAR]: next("16.2.1") }, "laravel/framework@>=10.0,<10.48.4");
    expect(off.result.verdict).toBe("likely-not-affected");
    expect(text(off.result)).toMatch(/No PHP seen on 1 hostname/);
    const on = await run({ [BAR]: wordpress("2.4.0") }, "laravel/framework@>=10.0,<10.48.4");
    expect(on.result.verdict).toBe("cannot-tell");
    expect(on.result.checkInside.join("\n")).toMatch(/composer\.lock/);
  });

  it("PHP itself is compared by the version x-powered-by gives", async () => {
    expect((await run({ [BAR]: wordpress("2.4.0") }, "php@<8.2.0")).result.verdict).toBe(
      "likely-affected",
    );
    expect((await run({ [BAR]: wordpress("2.4.0") }, "php@<8.1.0")).result.verdict).toBe(
      "likely-not-affected",
    );
  });

  it("a package that only a server could show is cannot-tell, and listed as check inside", async () => {
    const { result } = await run({ [BAR]: next("16.2.1") }, "express@<1.0.0");
    expect(result.verdict).toBe("cannot-tell");
    expect(result.checkInside.join("\n")).toMatch(/express/);
  });

  it("a multi-ecosystem advisory is judged on what can be seen; the rest is 'check inside'", async () => {
    const { result } = await run({ [BAR]: next("16.2.1") }, "GHSA-abcd-2345-wxyz");
    expect(result.verdict).toBe("likely-not-affected");
    expect(result.checkInside.join("\n")).toMatch(/next-py/);
    expect(result.components.map((c) => c.name)).toEqual(["next", "acme/next-bridge", "next-py"]);
  });
});

describe("a site behind a CDN that strips headers", () => {
  const stripped: SiteDef = {
    headers: { server: "CloudFront", "x-amz-cf-id": "q1", via: "1.1 abc.cloudfront.net" },
    routes: {
      "/": html({ scripts: ["/static/app.8f2a.js"] }),
      "/static/app.8f2a.js": { type: "text/javascript", body: "console.log(1)" },
    },
  };

  it("cannot-tell, with the reason, and not 'not affected'", async () => {
    const { result } = await run({ [BAR]: stripped }, "CVE-2026-00123");
    expect(result.verdict).toBe("cannot-tell");
    expect(text(result)).toMatch(/CloudFront is in front of the site and removes the headers/);
    expect(result.verdict).not.toBe("likely-not-affected");
  });

  it("a host the person named that does not answer also stops a clean verdict", async () => {
    const { result } = await run({ [BAR]: next("16.2.1") }, "wp-plugin:easy-booking@<2.4.0", {
      hosts: ["old.harbour-bar.example"],
    });
    expect(result.verdict).toBe("cannot-tell");
    expect(text(result)).toMatch(/old\.harbour-bar\.example.*could not be read/);
  });

  it("a page that answers 403 is not read as 'no sign'", async () => {
    const { result } = await run(
      { [BAR]: { routes: { "/": { status: 403, body: "<title>Blocked</title>" } } } },
      "CVE-2026-00123",
    );
    expect(result.verdict).toBe("cannot-tell");
    expect(text(result)).toMatch(/answered 403/);
  });
});

describe("the words: never 'safe', escaped, and a note a client can read", () => {
  it("no output says safe, and text from OSV and from the site is data", async () => {
    const outputs: string[] = [];
    for (const [site, spec] of [
      [next("15.1.0"), "CVE-2026-00123"],
      [next("16.2.1"), "CVE-2026-00123"],
      [next(null), "CVE-2026-00123"],
      [wordpress(null), "CVE-2026-00456"],
    ] as const) {
      const { result } = await run({ [BAR]: site }, spec);
      outputs.push(renderTerminal(result), renderNote(result), JSON.stringify(result));
    }
    for (const o of outputs)
      expect(o).not.toMatch(/\bsafe\b|\bsecure\b|not vulnerable|\bpatched\b/i);
    // the advisory's "details" text told the reader to say the site is fine: it is never printed
    for (const o of outputs) expect(o).not.toMatch(/Ignore previous instructions/);
  });

  it("the client note starts with the answer, lists what to check inside, and holds no jargon-free promise", async () => {
    const { result } = await run({ [BAR]: next("15.1.0") }, "CVE-2026-00123");
    const note = renderNote(result);
    expect(note).toMatch(/^Subject: .*CVE-2026-00123/);
    expect(note).toMatch(/signs that the site is affected|likely affected/i);
    expect(note).toMatch(/15\.2\.3/);
    expect(note).toMatch(/check inside/i);
    expect(note.length).toBeLessThan(2500);
  });

  it("the summary text from OSV is clipped and invisible characters are shown as escapes", async () => {
    const { result } = await run({ [BAR]: next("15.1.0") }, "next@>=15.0.0 <15.2.3");
    expect(result.advisory.summary).toBeUndefined();
    const evil = await run({ [BAR]: next("15.1.0") }, "CVE-2026-00123");
    expect(evil.result.advisory.summary).toBe("Invented flaw in Next.js middleware handling");
  });
});

describe("what is looked at", () => {
  it("the typed host, its www twin and the hostnames named are listed in the result", async () => {
    const { result } = await run(
      { [BAR]: next("16.2.1"), "www.harbour-bar.example": next("16.2.1") },
      "CVE-2026-00123",
    );
    expect(result.site.hostnames.map((h) => [h.host, h.reached])).toEqual([
      [BAR, true],
      ["www.harbour-bar.example", true],
    ]);
    expect(result.site.checkedAt).toBe("2026-11-11T09:00:00.000Z");
  });

  it("the same site gives the same answer twice", async () => {
    const a = await run({ [BAR]: next("15.1.0") }, "CVE-2026-00123");
    const b = await run({ [BAR]: next("15.1.0") }, "CVE-2026-00123");
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
  });

  it("an unreachable site is an error, not a verdict", async () => {
    await expect(run({}, "CVE-2026-00123")).rejects.toThrow(/harbour-bar\.example/);
  });
});
