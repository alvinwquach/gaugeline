import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { createNetworkTransport, type RenderRequest, type RenderResult } from "@gaugeline/core";
import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_PATH_VARIABLE, findBrowser } from "../browser.js";
import { createPlaywrightRenderer } from "../playwright.js";

/**
 * The adapter against a real browser and the invented bakery on a loopback socket. It runs only where a
 * browser is installed (and skips, saying why, where none is or it will not start), so a runner without
 * one stays green. The page's own network is never used: the site's own log shows what left.
 */

const found = findBrowser({
  env: process.env,
  exists: existsSync,
  platform: process.platform,
});
let driverMissing = false;
try {
  await import("playwright-core");
} catch {
  driverMissing = true;
}
const skipReason = driverMissing
  ? "playwright-core is not installed"
  : found.ok
    ? undefined
    : `no Chromium browser was found (${BROWSER_PATH_VARIABLE} unset, none installed)`;

describe.skipIf(skipReason !== undefined)("the Playwright adapter in a real browser", () => {
  let site: Fixture;
  let renderer: ReturnType<typeof createPlaywrightRenderer>;
  let unusable: string | undefined;
  const test = (name: string, run: () => Promise<void>, timeout = 60_000) =>
    it(
      name,
      async (ctx) => {
        if (unusable) ctx.skip(`the browser does not start here: ${unusable}`);
        await run();
      },
      timeout,
    );
  beforeAll(async () => {
    site = await startFixture("renderer-edges");
    renderer = createPlaywrightRenderer({
      transport: createNetworkTransport({ allowPrivate: true, target: site.origin }),
      // Chromium's sandbox cannot start as root (a container); everywhere else it is on.
      chromiumSandbox: process.getuid?.() !== 0,
      limits: { pages: 50, requests: 60, redirects: 5, responseBytes: 1_000_000, ms: 15_000 },
    });
    // A browser that is installed but will not start here (a sandbox the machine does not allow, a missing
    // library) is a reason to skip these tests, said out loud, and never a failure of the change under test.
    const probe = await renderer.render({ url: `${site.origin}/menu.html` });
    if (probe.kind === "could-not-check" && /could not start/.test(probe.reason))
      unusable = probe.reason;
  }, 60_000);
  afterAll(async () => {
    await renderer?.close();
    await site?.close();
  });

  async function render(path: string, extra: Partial<RenderRequest> = {}) {
    const result: RenderResult = await renderer.render({ url: `${site.origin}${path}`, ...extra });
    return result;
  }
  const rendered = (r: RenderResult) => {
    expect(r.kind, JSON.stringify(r)).toBe("rendered");
    return r as Extract<RenderResult, { kind: "rendered" }>;
  };
  const refused = (r: RenderResult) => {
    expect(r.kind, JSON.stringify(r)).toBe("could-not-check");
    return r as Extract<RenderResult, { kind: "could-not-check" }>;
  };
  /** What reached the site: nothing but GETs. */
  const onlyGets = () => expect([...site.methods.keys()].sort()).toEqual(["GET"]);

  test("renders a page the way a visitor sees it: the script's line is in the text", async () => {
    const page = rendered(await render("/"));
    expect(page).toMatchObject({
      status: 200,
      finalUrl: `${site.origin}/`,
      title: "Quillfeather Bakery",
    });
    expect(page.text).toContain("This line is written by a script after the page loads.");
    expect(page.links?.map((l) => l.text)).toEqual(["About", "Menu", "Partners"]);
    // The analytics tag was asked for and refused; the logo was allowed.
    expect(page.blocked.analytics).toBe(1);
    expect(page.requests.some((q) => q.url.endsWith("/logo.svg") && q.verdict === "allowed")).toBe(
      true,
    );
    onlyGets();
  }, 60_000);

  test("stops a POST form and the posts a page sends from script", async () => {
    const page = rendered(await render("/post-form.html"));
    expect(page.blocked.form).toBeGreaterThanOrEqual(1);
    expect(page.blocked.method).toBe(3);
    expect(site.hits.get("/submit")).toBeUndefined();
    expect(site.hits.get("/api/save")).toBeUndefined();
    onlyGets();
  }, 60_000);

  test("stops a GET form from navigating, and counts it", async () => {
    const page = rendered(await render("/get-form.html"));
    expect(page.blocked.form).toBe(1);
    expect(page.finalUrl).toBe(`${site.origin}/get-form.html`);
    expect(site.hits.get("/search.html")).toBeUndefined();
  }, 60_000);

  test("stops a form a page submits by clicking its own button: the submit event is cancelled", async () => {
    const page = rendered(await render("/form-click.html"));
    expect(page.blocked.form).toBeGreaterThanOrEqual(1);
    expect(page.finalUrl).toBe(`${site.origin}/form-click.html`);
    expect(site.hits.get("/search.html")).toBeUndefined();
  });

  test("is could-not-check for a page that is slower than the time cap, at that cap", async () => {
    const slow = createPlaywrightRenderer({
      transport: createNetworkTransport({ allowPrivate: true, target: site.origin }),
      chromiumSandbox: process.getuid?.() !== 0,
      limits: { ms: 1000 },
    });
    try {
      const started = Date.now();
      const answer = refused(await slow.render({ url: `${site.origin}/slow` }));
      // The browser gave up at the cap (the page needs 3 s), not at the hang guard 5 s after it.
      expect(answer.reason).toMatch(/did not load|time/);
      expect(Date.now() - started).toBeLessThan(2900);
    } finally {
      await slow.close();
    }
  });

  test("blocks analytics beacons, wherever they go", async () => {
    const page = rendered(await render("/beacon.html"));
    expect(page.blocked.analytics).toBe(2);
    expect(page.blocked.method).toBe(1);
    expect(site.hits.get("/collect")).toBeUndefined();
    expect(
      page.requests.filter(
        (q) => q.verdict === "allowed" && /google-analytics|linkedin/.test(q.url),
      ),
    ).toEqual([]);
    onlyGets();
  }, 60_000);

  test("closes the windows a page opens and never loads them", async () => {
    const page = rendered(await render("/popup.html"));
    expect(page.blocked.popup).toBeGreaterThanOrEqual(2);
    expect(site.hits.get("/about.html")).toBeUndefined();
  }, 60_000);

  test("never connects a WebSocket", async () => {
    const page = rendered(await render("/socket.html"));
    expect(page.blocked.websocket).toBe(2);
    expect(site.hits.get("/socket")).toBeUndefined();
  }, 60_000);

  test("follows a redirect that ends on a page, and reports that page", async () => {
    const page = rendered(await render("/ok-redirect"));
    expect(page).toMatchObject({
      status: 200,
      finalUrl: `${site.origin}/about.html`,
      title: "About Quillfeather",
    });
  }, 60_000);

  test("is could-not-check for a redirect to a metadata address, and never connects to it", async () => {
    const answer = refused(await render("/to-private"));
    expect(answer.reason).toMatch(/private|metadata/);
    expect(answer.hint).toContain("--allow-private");
    expect(answer.blocked?.address).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("is could-not-check for a redirect to another port on loopback", async () => {
    refused(await render("/to-other-port"));
  }, 60_000);

  test("is could-not-check for an infinite redirect", async () => {
    expect(refused(await render("/loop")).reason).toMatch(/redirect/);
  }, 60_000);

  test("is could-not-check for a huge page", async () => {
    expect(refused(await render("/huge")).reason).toMatch(/bytes/);
  }, 60_000);

  test("is could-not-check for a page that asks for too many things", async () => {
    expect(refused(await render("/many.html")).reason).toMatch(/requests/);
  }, 60_000);

  test("refuses private subresources and renders the page anyway", async () => {
    const page = rendered(await render("/private-sub.html"));
    expect(page.blocked.address).toBe(2);
  }, 60_000);

  test("sends no UDP packet: WebRTC, WebTransport and media capture reach nothing", async () => {
    // A local UDP listener the run did not allow: a STUN and a TURN server, and a WebTransport endpoint.
    const udp = createSocket("udp4");
    let packets = 0;
    udp.on("message", () => (packets += 1));
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    try {
      const page = rendered(await render(`/webrtc.html?port=${udp.address().port}`));
      // The names are gone, so the page's own attempts fail at once.
      expect(page.title).toContain("rtc:TypeError");
      expect(page.title).toContain("webTransport:TypeError");
      expect(page.title).toContain("media:TypeError");
      // Time for any packet a missed attempt would send.
      await new Promise((r) => setTimeout(r, 1500));
      expect(packets).toBe(0);
    } finally {
      udp.close();
    }
  });

  test("gives every page a fresh browser state, at the viewport it is asked for", async () => {
    const one = rendered(await render("/state.html", { viewport: { width: 375, height: 667 } }));
    const two = rendered(await render("/state.html", { viewport: { width: 1280, height: 800 } }));
    expect(one.title).toBe("before:|| width:375");
    expect(two.title).toBe("before:|| width:1280");
  }, 60_000);
});

describe.skipIf(skipReason === undefined)("the Playwright adapter without a browser", () => {
  it(`is skipped here: ${skipReason ?? ""}`, () => {
    expect(skipReason).toBeDefined();
  });
});
