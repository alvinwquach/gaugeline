import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { gatherEvidence, type GatherOptions } from "../evidence.js";
import { html, worldTransport, type SiteDef } from "./world.js";

const BAR = "harbour-bar.example";

/** A Next.js build's client chunk, as an invented stand-in: only the shape a build leaves. */
const chunk = (version: string): string =>
  `(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[1],{1:function(){window.next={version:"${version}",appDir:!0}}}]);`;

const next = (version: string | null, headers: Record<string, string> = {}): SiteDef => ({
  headers: { server: "Vercel", "x-vercel-id": "lhr1::abc", ...headers },
  routes: {
    "/": html({ scripts: ["/_next/static/chunks/main-app-3f2a.js"] }),
    "/_next/static/chunks/main-app-3f2a.js": {
      type: "text/javascript",
      body: version ? chunk(version) : 'console.log("app");',
    },
  },
});

const onBar = (seen: { url: string }[]) => seen.filter((r) => new URL(r.url).hostname === BAR);

async function gather(
  sites: Record<string, SiteDef>,
  over: Partial<GatherOptions> = {},
  address = `https://${BAR}/`,
) {
  const world = worldTransport(sites);
  const fetcher = createFetcher({ transport: world.transport });
  const evidence = await gatherEvidence({
    fetcher,
    address,
    hosts: [],
    needs: { next: true, libraries: false },
    ...over,
  });
  return { evidence, world };
}

describe("evidence from one host: Next.js", () => {
  it("reads the version from the page's own chunk, and the host from its headers", async () => {
    const { evidence } = await gather({ [BAR]: next("16.2.1") });
    const h = evidence.hosts[0];
    expect(h?.hosting).toBe("Vercel");
    expect(h?.stacks).toContain("Next.js");
    expect(h?.next).toEqual({
      version: "16.2.1",
      how: "window.next.version in the script main-app-3f2a.js",
    });
  });

  it("a Next.js site whose chunk does not say the version: seen, no version", async () => {
    const { evidence } = await gather({ [BAR]: next(null) });
    expect(evidence.hosts[0]?.next).toEqual({});
  });

  it("x-powered-by: Next.js alone is a sign of Next.js, with no version", async () => {
    const { evidence } = await gather({
      [BAR]: { headers: { "x-powered-by": "Next.js" }, routes: { "/": html() } },
    });
    expect(evidence.hosts[0]?.next).toEqual({});
    expect(evidence.hosts[0]?.stacks).toContain("Next.js");
  });

  it("does not read a script when the question is not about one", async () => {
    const { world } = await gather(
      { [BAR]: next("16.2.1") },
      { needs: { next: false, libraries: false } },
    );
    expect(onBar(world.seen).map((r) => new URL(r.url).pathname)).toEqual(["/"]);
  });

  it("only asks for scripts the page names, with GET, at most once each", async () => {
    const { world } = await gather({ [BAR]: next("16.2.1") });
    expect(world.seen.every((r) => r.method === "GET")).toBe(true);
    const paths = onBar(world.seen).map((r) => new URL(r.url).pathname);
    expect(paths.filter((p) => p.endsWith(".js"))).toEqual([
      "/_next/static/chunks/main-app-3f2a.js",
    ]);
  });
});

describe("evidence from one host: PHP and WordPress", () => {
  const wp = (extra = ""): SiteDef => ({
    headers: { server: "nginx", "x-powered-by": "PHP/8.1.27" },
    routes: {
      "/": html({
        head: `<meta name="generator" content="WordPress 6.4.2"><link rel="stylesheet" href="/wp-content/plugins/easy-booking/css/style.css?ver=2.1.3">${extra}`,
        scripts: [
          "/wp-includes/js/jquery/jquery.min.js?ver=3.7.1",
          "/wp-content/plugins/easy-booking/js/app.js?ver=2.1.3",
          "/wp-content/plugins/gallery-lite/js/g.js?ver=6.4.2",
          "/wp-content/themes/harbour/js/t.js?ver=1.0.4",
        ],
      }),
    },
  });

  it("reads PHP's version from x-powered-by", async () => {
    const { evidence } = await gather(
      { [BAR]: wp() },
      { needs: { next: false, libraries: false } },
    );
    expect(evidence.hosts[0]?.php).toEqual({ version: "8.1.27", how: "the X-Powered-By header" });
  });

  it("reads WordPress's version, the plugins and the theme from the page's own asset addresses", async () => {
    const { evidence } = await gather(
      { [BAR]: wp() },
      { needs: { next: false, libraries: false } },
    );
    const w = evidence.hosts[0]?.wordpress;
    expect(w?.version).toEqual({ value: "6.4.2", how: "the generator tag" });
    expect(w?.plugins).toEqual([
      { slug: "easy-booking", versions: ["2.1.3"] },
      // ver= 6.4.2 is WordPress's own number, which it writes when a plugin gives none: not the plugin's version
      { slug: "gallery-lite", versions: [] },
    ]);
    expect(w?.themes).toEqual([{ slug: "harbour", versions: ["1.0.4"] }]);
    expect(evidence.hosts[0]?.stacks).toEqual(expect.arrayContaining(["WordPress", "PHP"]));
  });

  it("with the generator tag removed, the version comes from wp-includes assets", async () => {
    const site: SiteDef = {
      headers: {},
      routes: {
        "/": html({
          scripts: [
            "/wp-includes/js/wp-emoji-release.min.js?ver=6.3.1",
            "/wp-content/plugins/a-b/c.js",
          ],
        }),
      },
    };
    const { evidence } = await gather(
      { [BAR]: site },
      { needs: { next: false, libraries: false } },
    );
    expect(evidence.hosts[0]?.wordpress?.version).toEqual({
      value: "6.3.1",
      how: "the version on the site's wp-includes files",
    });
    expect(evidence.hosts[0]?.wordpress?.plugins).toEqual([{ slug: "a-b", versions: [] }]);
  });

  it("a plugin whose files carry two different versions keeps both", async () => {
    const site: SiteDef = {
      routes: {
        "/": html({
          scripts: [
            "/wp-content/plugins/x-form/a.js?ver=1.0.0",
            "/wp-content/plugins/x-form/b.js?ver=1.2.0",
          ],
        }),
      },
    };
    const { evidence } = await gather(
      { [BAR]: site },
      { needs: { next: false, libraries: false } },
    );
    expect(evidence.hosts[0]?.wordpress?.plugins).toEqual([
      { slug: "x-form", versions: ["1.0.0", "1.2.0"] },
    ]);
  });

  it("uses the WordPress adapter's read when it is given, and says where it came from", async () => {
    const site: SiteDef = { routes: { "/": html() } };
    const { evidence } = await gather(
      { [BAR]: site },
      {
        needs: { next: false, libraries: false },
        wordpress: { version: "6.2.0", plugins: [{ slug: "easy-booking", version: "2.0.9" }] },
      },
    );
    const w = evidence.hosts[0]?.wordpress;
    expect(w?.version).toEqual({ value: "6.2.0", how: "the WordPress adapter's read" });
    expect(w?.plugins).toEqual([{ slug: "easy-booking", versions: ["2.0.9"] }]);
  });
});

describe("evidence from a CDN and from other hostnames", () => {
  it("a CDN that removes the headers, on a page that names nothing, is opaque", async () => {
    const { evidence } = await gather({
      [BAR]: {
        headers: { server: "CloudFront", "x-amz-cf-id": "q1", via: "1.1 abc.cloudfront.net" },
        routes: { "/": html({ scripts: ["/static/app.8f2a.js"] }) },
      },
    });
    const h = evidence.hosts[0];
    expect(h?.cdn).toBe("CloudFront");
    expect(h?.stacks).toEqual([]);
    expect(h?.opaque).toMatch(/CloudFront/);
  });

  it("looks at the www twin, and a twin that does not answer is a note and not a failure", async () => {
    const { evidence } = await gather({ [BAR]: next("16.2.1") });
    expect(evidence.hosts.map((h) => h.host)).toEqual([BAR, `www.${BAR}`]);
    expect(evidence.hosts[1]?.read).toMatchObject({ ok: false });
    expect(evidence.hosts[1]?.required).toBe(false);
  });

  it("a hostname the person names that does not answer is required, and says so", async () => {
    const { evidence } = await gather(
      { [BAR]: next("16.2.1") },
      { hosts: ["old.harbour-bar.example"] },
    );
    const old = evidence.hosts.find((h) => h.host === "old.harbour-bar.example");
    expect(old?.required).toBe(true);
    expect(old?.read).toMatchObject({ ok: false });
  });

  it("an old subdomain the page links to is looked at, and a PHP site on it is seen", async () => {
    const { evidence } = await gather({
      [BAR]: {
        routes: { "/": html({ body: '<a href="https://bookings.harbour-bar.example/">Book</a>' }) },
      },
      "bookings.harbour-bar.example": {
        headers: { "x-powered-by": "PHP/7.4.33" },
        routes: { "/": html() },
      },
    });
    const old = evidence.hosts.find((h) => h.host === "bookings.harbour-bar.example");
    expect(old?.php?.version).toBe("7.4.33");
  });

  it("the primary site not answering is an error and not a verdict", async () => {
    await expect(gather({}, {}, "https://nothing.example/")).rejects.toThrow(/nothing\.example/);
  });
});

describe("evidence: served libraries (E-12's detection)", () => {
  it("names the libraries and versions the page's scripts carry", async () => {
    const { evidence } = await gather(
      {
        [BAR]: {
          routes: {
            "/": html({ scripts: ["/js/jquery.min.js", "/js/theme.min.js"] }),
            "/js/jquery.min.js": {
              type: "text/javascript",
              body: "/*! jQuery JavaScript Library v1.12.4 */\n",
            },
            "/js/theme.min.js": { type: "text/javascript", body: `${"a".repeat(1200)}` },
          },
        },
      },
      { needs: { next: false, libraries: true } },
    );
    const h = evidence.hosts[0];
    expect(h?.libraries).toEqual([
      {
        library: "jquery",
        name: "jQuery",
        version: "1.12.4",
        how: "banner",
        script: `https://${BAR}/js/jquery.min.js`,
      },
    ]);
    expect(h?.scriptsUnidentified).toBe(1);
  });

  it("a script that cannot be read is counted, not skipped quietly", async () => {
    const { evidence } = await gather(
      { [BAR]: { routes: { "/": html({ scripts: ["/js/gone.js"] }) } } },
      { needs: { next: false, libraries: true } },
    );
    expect(evidence.hosts[0]?.scriptsUnread).toBe(1);
  });
});
