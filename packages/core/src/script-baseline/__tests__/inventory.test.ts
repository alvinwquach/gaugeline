import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../../snapshot.js";
import { KNOWN_BAD_HOSTS, knownBadHost } from "../known-bad.js";
import {
  NONCE_OR_HASH,
  buildBaseline,
  parseCsp,
  parseHsts,
  parsePermissions,
  readBaseline,
  thirdPartyKey,
} from "../inventory.js";

// Built at run time: no key-shaped string is in the repository.
const KEY = ["sk", "live", "BaselineTestNotAKey000"].join("_");

function page(
  body: string,
  headers: Record<string, string> = {},
  url = "https://smilebright.example/book",
) {
  return buildSnapshot([
    { url, status: 200, headers: { "content-type": "text/html", ...headers }, body, ms: 1 },
  ]);
}

describe("script baseline: unit", () => {
  it("lists third-party scripts by host and path, with the integrity attribute, and leaves out the rest", () => {
    const s = page(`<html><body>
      <script src="/app.js"></script>
      <script src="https://cdn.smilebright.example/vendor.js"></script>
      <script src="https://js.stripe.example/v3/?key=${KEY}#frag" integrity="sha384-abc" crossorigin></script>
      <script src="https://tags.analytics.example/gtm.js?id=GTM-1234"></script>
      <script src="//widgets.booking.example:8443/embed.js"></script>
      <script>window.inline = "${KEY}";</script>
    </body></html>`);
    const b = buildBaseline(s);
    expect(b.scripts).toEqual({
      "js.stripe.example/v3/": { sri: true },
      "tags.analytics.example/gtm.js": { sri: false },
      "widgets.booking.example:8443/embed.js": { sri: false },
    });
    expect(JSON.stringify(b)).not.toContain(KEY);
    expect(JSON.stringify(b)).not.toContain("GTM-1234");
  });

  it("counts a file as protected only when every tag for it has an integrity attribute", () => {
    const b = buildBaseline(
      page(
        `<script src="https://a.cdn.example/x.js" integrity="sha256-1"></script><script src="https://a.cdn.example/x.js?v=2"></script>`,
      ),
    );
    expect(b.scripts).toEqual({ "a.cdn.example/x.js": { sri: false } });
  });

  it("keeps the security headers with their directive lists, and nothing else", () => {
    const b = buildBaseline(
      page("<p>hi</p>", {
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' https://js.stripe.example 'nonce-AbC123'; upgrade-insecure-requests",
        "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": 'camera=(), geolocation=(self "https://maps.example")',
        "set-cookie": `session=${KEY}`,
        server: "nginx",
      }),
    );
    expect(Object.keys(b.headers).sort()).toEqual([
      "content-security-policy",
      "permissions-policy",
      "referrer-policy",
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options",
    ]);
    expect(b.headers["content-security-policy"]).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://js.stripe.example", NONCE_OR_HASH],
      "upgrade-insecure-requests": [],
    });
    expect(b.headers["strict-transport-security"]).toEqual({
      "max-age": ["63072000"],
      includesubdomains: [],
      preload: [],
    });
    expect(b.headers["permissions-policy"]).toEqual({
      camera: [],
      geolocation: ["self", "https://maps.example"],
    });
    expect(b.headers["x-frame-options"]).toEqual({ "": ["deny"] });
    expect(JSON.stringify(b)).not.toContain("AbC123");
    expect(JSON.stringify(b)).not.toContain(KEY);
  });

  it("parseCsp: a hash is the same marker as a nonce, and a second policy is named #2", () => {
    expect(parseCsp("script-src 'sha256-xyz' 'nonce-q'; img-src *, script-src 'none'")).toEqual({
      "script-src": [NONCE_OR_HASH],
      "img-src": ["*"],
      "script-src#2": ["'none'"],
    });
  });

  it("parsers survive junk and names that are properties of every object", () => {
    const d = parseCsp(";;; __proto__ x; constructor y; constructor z");
    expect(Object.keys(d)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(d)).toBeNull();
    expect(d["constructor"]).toEqual(["y"]);
  });

  it("parseHsts and parsePermissions read the usual shapes", () => {
    expect(parseHsts("max-age=300")).toEqual({ "max-age": ["300"] });
    expect(parsePermissions("camera=*, microphone=(self)")).toEqual({
      camera: ["*"],
      microphone: ["self"],
    });
  });

  it("thirdPartyKey: the page's own registrable domain and its subdomains are not third party", () => {
    const at = "https://www.smilebright.co.uk/";
    expect(thirdPartyKey("https://static.smilebright.co.uk/a.js", at)).toBeUndefined();
    expect(thirdPartyKey("https://other.co.uk/a.js?x=1", at)).toBe("other.co.uk/a.js");
    expect(thirdPartyKey("data:text/javascript,1", at)).toBeUndefined();
  });

  it("readBaseline accepts what buildBaseline wrote and refuses anything else", () => {
    const b = buildBaseline(page(`<script src="https://x.cdn.example/a.js"></script>`));
    expect(readBaseline(JSON.parse(JSON.stringify(b)))).toEqual(b);
    for (const bad of [
      null,
      5,
      {},
      { scripts: {}, headers: 3 },
      { scripts: { a: { sri: "yes" } }, headers: {} },
      { scripts: {}, headers: { h: { "": [1] } } },
    ])
      expect(readBaseline(bad)).toBeUndefined();
  });
});

describe("known-bad script hosts: the data file", () => {
  it("has polyfill.io first, and every entry names a lower-case host, a date, a note and an https source", () => {
    expect(KNOWN_BAD_HOSTS[0]?.host).toBe("polyfill.io");
    for (const k of KNOWN_BAD_HOSTS) {
      expect(k.host, k.host).toBe(k.host.toLowerCase());
      expect(k.host, k.host).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      expect(k.since, k.host).toMatch(/^\d{4}-\d{2}$/);
      expect(k.note.trim().length, k.host).toBeGreaterThan(10);
      expect(k.source.title.trim(), k.host).not.toBe("");
      expect(k.source.url, k.host).toMatch(/^https:\/\//);
      expect(typeof k.proposed, k.host).toBe("boolean");
    }
  });

  it("each entry matches itself and a subdomain, and not a host that only ends the same way", () => {
    for (const k of KNOWN_BAD_HOSTS) {
      expect(knownBadHost(k.host)?.host).toBe(k.host);
      expect(knownBadHost(`cdn.${k.host}`)?.host).toBe(k.host);
      expect(knownBadHost(`not${k.host}`)).toBeUndefined();
    }
    expect(knownBadHost("cdnjs.cloudflare.com")).toBeUndefined();
  });
});
