import { describe, expect, it } from "vitest";
import { PLANTED, startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import type { ScriptRead } from "../../scripts.js";
import { checkSite } from "../../site.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { redact } from "../leaks/detectors.js";
import { stripeTestMode } from "../stripe-test-mode.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const pk = (mode: "live" | "test", rest: string) => ["pk", mode, rest].join("_");
const TEST = pk("test", "51HxPopUpKitchenTestKey0123456789");
const OTHER = pk("test", "51HxPopUpKitchenOtherKey012345678");

function page(url: string, body: string, headers: Record<string, string> = {}): PageSnapshot {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html", ...headers },
      body,
      ms: 1,
    },
  ]);
}

const script = (url: string, text: string): ScriptRead => ({
  url,
  status: 200,
  text,
  truncated: false,
});

function ctx(scripts?: ScriptRead[]): CheckContext {
  return {
    warn: () => undefined,
    ...(scripts ? { scripts: () => Promise.resolve(scripts) } : {}),
  };
}

const run = (p: PageSnapshot, scripts?: ScriptRead[]) => stripeTestMode.run(p, ctx(scripts));

describe("stripe-test-mode: unit", () => {
  it("is a high check in Sales & prices and explains itself", () => {
    expect(stripeTestMode.id).toBe("stripe-test-mode");
    expect(stripeTestMode.severity).toBe("high");
    expect(stripeTestMode.area).toBe("Sales & prices");
    expect(
      stripeTestMode.what && stripeTestMode.why && stripeTestMode.fix && stripeTestMode.tech,
    ).toBeTruthy();
  });

  it("pk_test_ in an inline script is a finding, redacted", async () => {
    const p = page("https://larder.example/", `<script>Stripe("${TEST}")</script>`);
    const found = await run(p);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "stripe-test-mode",
      severity: "high",
      url: "https://larder.example/",
    });
    expect(found[0]?.evidence).toBe(`Stripe test key ${redact(TEST)} in the HTML of /`);
    expect(JSON.stringify(found)).not.toContain(TEST);
  });

  it("pk_test_ in an external same-site script is a finding that names the file", async () => {
    const p = page("https://larder.example/", "<p>hello</p>");
    const found = await run(p, [
      script("https://larder.example/checkout.js", `var k = "${TEST}";`),
    ]);
    expect(found.map((f) => f.evidence)).toEqual([
      `Stripe test key ${redact(TEST)} in /checkout.js`,
    ]);
  });

  it("pk_test_ inside a longer word does not match", async () => {
    const p = page(
      "https://larder.example/",
      `<script>var a = "x${TEST}"; var b = "my_${TEST}"</script>`,
    );
    expect(
      await run(p, [script("https://larder.example/a.js", `var c = "spk_${TEST.slice(3)}"`)]),
    ).toEqual([]);
  });

  it("a live publishable key, a secret key and prose about test keys are not findings", async () => {
    const p = page(
      "https://larder.example/",
      `<script>Stripe("${pk("live", "51HxPopUpKitchenLiveKey0123456789")}")</script><p>Use pk_test_ keys while building.</p>`,
    );
    expect(await run(p)).toEqual([]);
  });

  it("on a preview host (vercel.app, netlify.app, pages.dev) a test key is expected: no finding", async () => {
    for (const host of ["larder-git-main.vercel.app", "larder.netlify.app", "larder.pages.dev"]) {
      const p = page(`https://${host}/`, `<script>Stripe("${TEST}")</script>`);
      expect(await run(p, [script(`https://${host}/a.js`, `"${OTHER}"`)]), host).toEqual([]);
    }
  });

  it("vercel.com itself is not a preview domain", async () => {
    const p = page("https://vercel.com/", `<script>Stripe("${TEST}")</script>`);
    expect(await run(p)).toHaveLength(1);
  });

  it("a page that is not HTML, or did not load, is not judged", async () => {
    const json = page("https://larder.example/x", `{"k":"${TEST}"}`, {
      "content-type": "application/json",
    });
    expect(await run(json)).toEqual([]);
    const missing = buildSnapshot([
      { url: "https://larder.example/", status: 404, headers: {}, body: TEST, ms: 1 },
    ]);
    expect(await run(missing)).toEqual([]);
  });

  it("one finding per key per place: the same key twice on a page is reported once", async () => {
    const p = page("https://larder.example/", `<script>a("${TEST}"); b("${TEST}")</script>`);
    expect(await run(p)).toHaveLength(1);
    const two = page("https://larder.example/", `<script>a("${TEST}"); b("${OTHER}")</script>`);
    expect(await run(two)).toHaveLength(2);
  });

  it("without a script reader it still reads the page, and sends no request of its own", async () => {
    const p = page("https://larder.example/", `<script>Stripe("${TEST}")</script>`);
    const requests: string[] = [];
    const c: CheckContext = {
      warn: () => undefined,
      fetcher: {
        get: (url: string) => {
          requests.push(url);
          return Promise.reject(new Error("no requests allowed"));
        },
      } as unknown as CheckContext["fetcher"],
    };
    expect(await stripeTestMode.run(p, c)).toHaveLength(1);
    expect(requests).toEqual([]);
  });
});

describe("stripe-test-mode: integration (the stripe-test-mode fixture)", () => {
  it("finds the key in the page and the one in the same-site script, and nothing else", async () => {
    const site = await startFixture("stripe-test-mode");
    try {
      const fetcher = createFetcher({ allowPrivate: true, target: site.origin });
      const { result } = await checkSite({
        address: site.origin,
        fetcher,
        only: ["stripe-test-mode"],
      });
      const a = PLANTED["stripe-publishable-test"] ?? "";
      const b = PLANTED["stripe-publishable-test-shop"] ?? "";
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        ["stripe-test-mode", "high", `Stripe test key ${redact(a)} in the HTML of /`],
        ["stripe-test-mode", "high", `Stripe test key ${redact(b)} in /checkout.js`],
      ]);
      expect(JSON.stringify(result)).not.toContain(a);
      expect(JSON.stringify(result)).not.toContain(b);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("reuses the script bodies the leak check reads: the file is requested once for both checks", async () => {
    const site = await startFixture("stripe-test-mode");
    try {
      const fetcher = createFetcher({ allowPrivate: true, target: site.origin });
      const { result } = await checkSite({
        address: site.origin,
        fetcher,
        only: ["stripe-test-mode", "secret-in-js"],
      });
      expect(result.findings.map((f) => f.checkId)).toEqual([
        "stripe-test-mode",
        "stripe-test-mode",
      ]);
      const script = site.requests.filter((r) => r.path === "/checkout.js");
      expect(script).toHaveLength(1);
      expect(site.requests.every((r) => r.method === "GET" || r.method === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });
});
