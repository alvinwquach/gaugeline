import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { parseOsv } from "../osv.js";
import { parseRange, parseVersion, inRange } from "../range.js";
import { renderNote } from "../render.js";
import { checkAdvisory, type AdvisoryOptions } from "../run.js";
import { html, worldTransport, type SiteDef } from "./world.js";

/**
 * Tests written for the findings of the independent review of the first build. The principle behind most of
 * them: absence of evidence is never "likely-not-affected" unless the component could really have been seen.
 */
const BAR = "harbour-bar.example";
const NOW = () => new Date("2026-11-11T09:00:00.000Z");

async function run(
  sites: Record<string, SiteDef>,
  spec: string,
  over: Partial<AdvisoryOptions> = {},
) {
  const world = worldTransport(sites);
  const result = await checkAdvisory({
    fetcher: createFetcher({ transport: world.transport }),
    address: `https://${BAR}/`,
    spec,
    now: NOW,
    ...over,
  });
  return { result, world };
}

const text = (r: { evidence: string[] }) => r.evidence.join("\n");
const plain = (headers: Record<string, string> = {}, head = ""): SiteDef => ({
  headers,
  routes: { "/": html({ head }) },
});
const NEXT_RANGE = "next@>=15.0.0 <15.2.3";
const LARAVEL = "laravel/framework@>=10.0,<10.48.4";

describe("1. absence of a server-side stack is not 'likely-not-affected' without positive evidence", () => {
  it("a Laravel-like site that names nothing: a composer advisory is cannot-tell", async () => {
    const { result } = await run({ [BAR]: plain({ server: "nginx" }) }, LARAVEL);
    expect(result.verdict).toBe("cannot-tell");
    expect(result.checkInside.join("\n")).toMatch(/composer\.lock/);
  });

  it("a Next.js site on Vercel can front a PHP backend: a composer advisory is cannot-tell", async () => {
    const site: SiteDef = {
      headers: { server: "Vercel", "x-vercel-id": "x" },
      routes: {
        "/": html({ scripts: ["/_next/static/a.js"] }),
        "/_next/static/a.js": { type: "text/javascript", body: "1" },
      },
    };
    expect((await run({ [BAR]: site }, LARAVEL)).result.verdict).toBe("cannot-tell");
  });

  it("a static site on Netlify built with Hugo is positive evidence of no PHP: likely-not-affected", async () => {
    const hugo = plain(
      { server: "Netlify", "x-nf-request-id": "q" },
      '<meta name="generator" content="Hugo 0.120.4">',
    );
    const { result } = await run({ [BAR]: hugo }, LARAVEL);
    expect(result.verdict).toBe("likely-not-affected");
    expect(text(result)).toMatch(/No PHP seen on 1 hostname/);
  });

  it("a page that names nothing: a Next.js or WordPress advisory is cannot-tell, not a clean answer", async () => {
    const nothing = plain({ server: "nginx" });
    expect((await run({ [BAR]: nothing }, NEXT_RANGE)).result.verdict).toBe("cannot-tell");
    expect((await run({ [BAR]: nothing }, "wp-plugin:easy-booking@<2.4.0")).result.verdict).toBe(
      "cannot-tell",
    );
  });

  it("a CDN in front of a page whose only name is a generator tag is believed for Next.js, not for PHP", async () => {
    const site = plain(
      { server: "cloudflare", "cf-ray": "1" },
      '<meta name="generator" content="Acme Builder 2.0">',
    );
    expect((await run({ [BAR]: site }, NEXT_RANGE)).result.verdict).toBe("likely-not-affected");
    expect((await run({ [BAR]: site }, LARAVEL)).result.verdict).toBe("cannot-tell");
  });

  it("a headless front (Next.js) does not rule out WordPress behind it", async () => {
    const site: SiteDef = {
      headers: { server: "Vercel", "x-vercel-id": "x" },
      routes: {
        "/": html({ scripts: ["/_next/static/a.js"] }),
        "/_next/static/a.js": { type: "text/javascript", body: "1" },
      },
    };
    expect((await run({ [BAR]: site }, "wp-plugin:easy-booking@<2.4.0")).result.verdict).toBe(
      "cannot-tell",
    );
  });
});

describe("2. scripts not read are not 'not seen'", () => {
  const scripts = (n: number) => Array.from({ length: n }, (_, i) => `/js/s${i}.js`);
  const routes = (list: string[], over: Record<string, string> = {}): SiteDef["routes"] => ({
    "/": html({ scripts: list, head: '<meta name="generator" content="Hugo 0.1">' }),
    ...Object.fromEntries(
      list.map((s) => [s, { type: "text/javascript", body: over[s] ?? "var a=1;" }]),
    ),
  });

  it("jQuery 1.12 in the 21st of 25 scripts: the cap is counted, so not seen is cannot-tell", async () => {
    const list = scripts(25);
    const site: SiteDef = {
      routes: routes(list, { "/js/s20.js": "/*! jQuery JavaScript Library v1.12.4 */" }),
    };
    const { result } = await run({ [BAR]: site }, "jquery@<3.5.0");
    expect(result.verdict).toBe("cannot-tell");
    expect(text(result)).toMatch(/not read|could not be read|at most 20/);
  });

  it("a large script with no library name in it could be a bundle: cannot-tell", async () => {
    const site: SiteDef = {
      routes: routes(["/js/app.js"], { "/js/app.js": `var a=1;\n`.repeat(20000) }),
    };
    expect((await run({ [BAR]: site }, "jquery@<3.5.0")).result.verdict).toBe("cannot-tell");
  });

  it("a few small plain scripts, all read, none naming jQuery: likely-not-affected", async () => {
    const site: SiteDef = { routes: routes(["/js/a.js", "/js/b.js"]) };
    expect((await run({ [BAR]: site }, "jquery@<3.5.0")).result.verdict).toBe(
      "likely-not-affected",
    );
  });
});

describe("3. cache-busters are not versions", () => {
  it("a stability word must be a stability word: 8f3a2 and 20231105x are not versions", () => {
    expect(parseVersion("wordpress", "8f3a2")).toBeUndefined();
    expect(parseVersion("composer", "1.0.0-banana")).toBeUndefined();
    expect(parseVersion("wordpress", "1.0.0-beta2")?.pre).toBe("beta2");
    expect(parseVersion("wordpress", "2.1.0-RC1")?.pre).toBe("RC1");
  });

  const plugin = (ver: string): SiteDef => ({
    routes: {
      "/": html({
        head: '<meta name="generator" content="WordPress 6.4.2">',
        scripts: [`/wp-content/plugins/easy-booking/js/app.js?ver=${ver}`],
      }),
    },
  });

  it("?ver= that is a hash or a date is not the plugin's version: cannot-tell", async () => {
    for (const ver of ["8f3a2", "20231105", "1699999999", "2023.11.05"]) {
      const { result } = await run({ [BAR]: plugin(ver) }, "wp-plugin:easy-booking@<2.4.0");
      expect(result.verdict, ver).toBe("cannot-tell");
    }
  });

  it("a clean release number is still a version", async () => {
    expect(
      (await run({ [BAR]: plugin("2.1.3") }, "wp-plugin:easy-booking@<2.4.0")).result.verdict,
    ).toBe("likely-affected");
  });

  it("with WordPress's own version unknown, the number every plugin shares is not claimed as a plugin's", async () => {
    const site: SiteDef = {
      routes: {
        "/": html({
          scripts: [
            "/wp-content/plugins/easy-booking/js/a.js?ver=6.4.2",
            "/wp-content/plugins/gallery-lite/js/g.js?ver=6.4.2",
            "/wp-content/themes/harbour/js/t.js?ver=6.4.2",
          ],
        }),
      },
    };
    expect((await run({ [BAR]: site }, "wp-plugin:easy-booking@<6.5.0")).result.verdict).toBe(
      "cannot-tell",
    );
  });
});

describe("4. a theme not on the page is cannot-tell, like a plugin", () => {
  it("WordPress seen, another theme active, the theme asked about not on the page", async () => {
    const site: SiteDef = {
      routes: {
        "/": html({
          head: '<meta name="generator" content="WordPress 6.4.2">',
          scripts: ["/wp-content/themes/harbour/js/t.js?ver=1.0.4"],
        }),
      },
    };
    const { result } = await run({ [BAR]: site }, "wp-theme:twentytwenty@<2.0");
    expect(result.verdict).toBe("cannot-tell");
    expect(result.checkInside.join("\n")).toMatch(/Themes page/);
  });
});

describe("5. a component only the inside can show keeps the answer from being clean", () => {
  it("lodash outside the range plus a server-only npm package: cannot-tell, with the package under check inside", async () => {
    const jq: SiteDef = {
      routes: {
        "/": html({
          scripts: ["/js/lodash.js"],
          head: '<meta name="generator" content="Hugo 0.1">',
        }),
        "/js/lodash.js": {
          type: "text/javascript",
          body: '/** @license Lodash lodash.com/license */\n;(function(){var vn="4.17.21",n={};n.VERSION=vn;}).call(this);',
        },
      },
    };
    // alone, the served lodash 4.17.21 is outside the range
    expect((await run({ [BAR]: jq }, "lodash@<4.17.21")).result.verdict).toBe(
      "likely-not-affected",
    );
    const { result } = await run({ [BAR]: jq }, "lodash@<4.17.21", {
      packages: ["express@<4.19.2"],
    });
    expect(result.verdict).toBe("cannot-tell");
    expect(result.checkInside.join("\n")).toMatch(/express/);
    expect(text(result)).toMatch(/express/);
  });
});

describe("6 and 7. the client note leads with what decided, and says what was seen", () => {
  const next = (version: string): SiteDef => ({
    headers: { server: "Vercel", "x-vercel-id": "x" },
    routes: {
      "/": html({
        scripts: ["/_next/static/a.js"],
        body: Array.from(
          { length: 5 },
          (_, i) => `<a href="https://s${i}.harbour-bar.example/">s</a>`,
        ).join(""),
      }),
      "/_next/static/a.js": {
        type: "text/javascript",
        body: `window.next={version:"${version}",appDir:!0}`,
      },
    },
  });
  const many: Record<string, SiteDef> = {
    [BAR]: next("15.1.0"),
    ...Object.fromEntries(
      [0, 1, 2, 3, 4].map((i) => [`s${i}.harbour-bar.example`, next("15.1.0")]),
    ),
  };

  it("the deciding line is the first line of the evidence, and in the note, whatever the number of hosts", async () => {
    const { result } = await run(many, NEXT_RANGE);
    expect(result.evidence[0]).toMatch(/Next\.js 15\.1\.0 .*inside the affected versions/);
    expect(renderNote(result)).toMatch(/What I found\*\*\n- Next\.js 15\.1\.0/);
  });

  it("a version seen and outside the range is said, not 'no sign of the component'", async () => {
    const { result } = await run({ [BAR]: next("16.2.1") }, NEXT_RANGE);
    const note = renderNote(result);
    expect(note).toMatch(/16\.2\.1/);
    expect(note).toMatch(/outside the affected versions/);
    expect(note).not.toMatch(/no sign of the affected component/);
  });
});

describe("8. hyphen ranges with a partial upper bound", () => {
  it("composer and WordPress: 1.0 - 2.0 is >=1.0.0 <2.1", () => {
    for (const family of ["composer", "wordpress"] as const) {
      const set = parseRange(family, "1.0 - 2.0");
      expect(set && inRange(family, "2.0.5", set), family).toBe(true);
      expect(set && inRange(family, "2.1.0", set), family).toBe(false);
      const whole = parseRange(family, "1.0.0 - 2.1.0");
      expect(whole && inRange(family, "2.1.0", whole)).toBe(true);
      expect(whole && inRange(family, "2.1.1", whole)).toBe(false);
    }
    const npm = parseRange("npm", "1.0.0 - 2");
    expect(npm && inRange("npm", "2.9.0", npm)).toBe(true);
    expect(npm && inRange("npm", "3.0.0", npm)).toBe(false);
  });
});

describe("9. OSV ranges that cannot be read are never read as 'outside'", () => {
  it("one range fails to parse and another parses: the package has no range, with the reason", () => {
    const a = parseOsv({
      id: "OSV-2026-2",
      affected: [
        {
          package: { ecosystem: "npm", name: "next" },
          ranges: [
            { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "banana" }] },
            { type: "SEMVER", events: [{ introduced: "15.0.0" }, { fixed: "15.2.3" }] },
          ],
        },
      ],
    });
    expect(a.components[0]?.set).toBeUndefined();
    expect(a.components[0]?.unreadable).toMatch(/could not be read/);
  });

  it("a GIT range beside a readable one is only commits: ignored", () => {
    const a = parseOsv({
      id: "OSV-2026-3",
      affected: [
        {
          package: { ecosystem: "npm", name: "next" },
          ranges: [
            { type: "GIT", repo: "https://example.invalid/x", events: [{ introduced: "0" }] },
            { type: "SEMVER", events: [{ introduced: "15.0.0" }, { fixed: "15.2.3" }] },
          ],
        },
      ],
    });
    const set = a.components[0]?.set;
    expect(set && inRange("npm", "15.1.0", set)).toBe(true);
  });

  it("packages past the cap are counted and make the answer cannot-tell", async () => {
    const affected = Array.from({ length: 60 }, (_, i) => ({
      package: { ecosystem: "PyPI", name: `pkg-${i}` },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0" }] }],
    }));
    affected.push({
      package: { ecosystem: "npm", name: "next" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "15.0.0" }, { fixed: "15.2.3" }] }],
    } as never);
    const a = parseOsv({ id: "OSV-2026-4", affected });
    expect(a.omitted).toBeGreaterThan(0);
  });
});

describe("10. a host that failed to answer is unread evidence", () => {
  const hugo = plain(
    { server: "Netlify", "x-nf-request-id": "q" },
    '<meta name="generator" content="Hugo 0.1">',
  );
  const linked: SiteDef = {
    headers: { server: "Netlify", "x-nf-request-id": "q" },
    routes: {
      "/": html({
        head: '<meta name="generator" content="Hugo 0.1">',
        body: '<a href="https://app.harbour-bar.example/">App</a>',
      }),
    },
  };

  it("a linked subdomain that refuses the connection stops 'not seen'", async () => {
    const { result } = await run(
      { [BAR]: linked, "app.harbour-bar.example": { fail: "ECONNREFUSED", routes: {} } },
      NEXT_RANGE,
    );
    expect(result.verdict).toBe("cannot-tell");
    expect(text(result)).toMatch(/app\.harbour-bar\.example/);
  });

  it("a www twin that does not exist is not unread evidence: there is nothing there to read", async () => {
    expect((await run({ [BAR]: hugo }, NEXT_RANGE)).result.verdict).toBe("likely-not-affected");
  });
});

describe("11. a distribution's PHP number does not decide", () => {
  const php = (powered: string): SiteDef => ({
    headers: { "x-powered-by": powered },
    routes: { "/": html() },
  });

  it("PHP/8.1.2-1ubuntu2.14 inside the range is cannot-tell, naming the distribution build", async () => {
    const { result } = await run({ [BAR]: php("PHP/8.1.2-1ubuntu2.14") }, "php@<8.1.5");
    expect(result.verdict).toBe("cannot-tell");
    expect(text(result)).toMatch(/distribution build/);
  });

  it("a plain upstream number inside the range is still likely-affected; a distribution number outside is outside", async () => {
    expect((await run({ [BAR]: php("PHP/8.1.2") }, "php@<8.1.5")).result.verdict).toBe(
      "likely-affected",
    );
    expect((await run({ [BAR]: php("PHP/8.3.1+deb12u1") }, "php@<8.1.5")).result.verdict).toBe(
      "likely-not-affected",
    );
  });
});
