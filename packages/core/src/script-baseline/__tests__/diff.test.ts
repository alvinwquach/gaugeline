import { describe, expect, it } from "vitest";
import { diffBaselines } from "../diff.js";
import { parseHeader, type ScriptBaseline } from "../inventory.js";

/** A baseline from scripts ("host/path" -> sri) and headers as the server sent them. */
function base(
  scripts: Record<string, boolean> = {},
  headers: Record<string, string> = {},
): ScriptBaseline {
  return {
    scripts: Object.fromEntries(Object.entries(scripts).map(([k, sri]) => [k, { sri }])),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, parseHeader(k, v)])),
  };
}
const brief = (a: ScriptBaseline, b: ScriptBaseline) =>
  diffBaselines(a, b).map((c) => [c.checkId, c.severity, c.evidence]);

const CSP = "content-security-policy";

describe("script baseline diff: scripts", () => {
  it("a script that was not there last run is reported, with or without an integrity attribute", () => {
    const prev = base({ "js.stripe.example/v3/": true });
    const next = base({
      "js.stripe.example/v3/": true,
      "cdn.chatwidget.example/loader.js": false,
      "cdn.fonts.example/f.js": true,
    });
    expect(brief(prev, next)).toEqual([
      [
        "script-changed",
        "medium",
        "cdn.chatwidget.example/loader.js is new since the last run (no integrity attribute)",
      ],
      [
        "script-changed",
        "medium",
        "cdn.fonts.example/f.js is new since the last run (with integrity attribute)",
      ],
    ]);
  });

  it("a script that lost its integrity attribute is reported; one that gained it is not", () => {
    expect(brief(base({ "a.example/x.js": true }), base({ "a.example/x.js": false }))).toEqual([
      [
        "script-changed",
        "medium",
        "a.example/x.js has no integrity attribute now; last run it had one",
      ],
    ]);
    expect(brief(base({ "a.example/x.js": false }), base({ "a.example/x.js": true }))).toEqual([]);
  });

  it("a script that went away, and an unchanged page, are not changes", () => {
    expect(
      brief(
        base({ "a.example/x.js": false, "b.example/y.js": true }),
        base({ "b.example/y.js": true }),
      ),
    ).toEqual([]);
    expect(brief(base(), base())).toEqual([]);
  });

  it("a baseline read from a file cannot reach Object.prototype through a script named constructor", () => {
    const prev = JSON.parse('{"scripts":{},"headers":{}}') as ScriptBaseline;
    const next = base({ constructor: false });
    expect(brief(prev, next).map((c) => c[0])).toEqual(["script-changed"]);
  });
});

describe("script baseline diff: Content-Security-Policy", () => {
  it("a CSP that adds 'unsafe-inline' to script-src is high, and the evidence has both lists", () => {
    const prev = base(
      {},
      { [CSP]: "default-src 'self'; script-src 'self' https://js.stripe.example" },
    );
    const next = base(
      {},
      { [CSP]: "default-src 'self'; script-src 'self' https://js.stripe.example 'unsafe-inline'" },
    );
    expect(brief(prev, next)).toEqual([
      [
        "csp-loosened",
        "high",
        "content-security-policy: script-src now allows 'unsafe-inline'; last run it was 'self' https://js.stripe.example",
      ],
    ]);
  });

  it("a host added to img-src is medium; a host added to script-src is medium too, a risky source is high", () => {
    const prev = base({}, { [CSP]: "img-src 'self'; script-src 'self'" });
    expect(
      brief(
        prev,
        base({}, { [CSP]: "img-src 'self' https://photos.example; script-src 'self'" }),
      )[0]?.[1],
    ).toBe("medium");
    expect(
      brief(
        prev,
        base({}, { [CSP]: "img-src 'self'; script-src 'self' https://tags.example" }),
      )[0]?.[1],
    ).toBe("medium");
    expect(
      brief(prev, base({}, { [CSP]: "img-src 'self' data:; script-src 'self' data:" })).map(
        (c) => c[1],
      ),
    ).toEqual(["medium", "high"]);
  });

  it("a directive that is gone is reported, and a script directive that is gone is high", () => {
    const prev = base({}, { [CSP]: "script-src 'self'; frame-ancestors 'none'; report-uri /r" });
    expect(brief(prev, base({}, { [CSP]: "img-src 'self'" }))).toEqual([
      [
        "csp-loosened",
        "high",
        "content-security-policy: script-src is no longer in the policy; last run it was 'self'",
      ],
      [
        "csp-loosened",
        "medium",
        "content-security-policy: frame-ancestors is no longer in the policy; last run it was 'none'",
      ],
    ]);
  });

  it("the whole header gone is high", () => {
    const prev = base({}, { [CSP]: "default-src 'self'; img-src *" });
    expect(brief(prev, base())).toEqual([
      [
        "csp-loosened",
        "high",
        "content-security-policy is no longer sent; last run it had 2 directives",
      ],
    ]);
  });

  it("a tighter policy, a new directive, a new nonce and a first policy are not changes", () => {
    const prev = base({}, { [CSP]: "script-src 'self' https://a.example 'nonce-one'; img-src *" });
    const tighter = base(
      {},
      {
        [CSP]:
          "script-src 'self' 'nonce-two'; img-src 'self'; frame-ancestors 'none'; object-src 'none'",
      },
    );
    expect(brief(prev, tighter)).toEqual([]);
    expect(brief(base(), base({}, { [CSP]: "default-src 'unsafe-inline'" }))).toEqual([]);
  });

  it("dropping a second policy reads as its directives going; changing a hash is not a change", () => {
    const prev = base({}, { [CSP]: "script-src 'self' 'sha256-aaa', script-src 'none'" });
    expect(brief(prev, base({}, { [CSP]: "script-src 'self' 'sha256-bbb'" }))).toEqual([
      [
        "csp-loosened",
        "high",
        "content-security-policy: script-src#2 is no longer in the policy; last run it was 'none'",
      ],
    ]);
  });

  it("report-uri changing is not a loosening", () => {
    expect(
      brief(base({}, { [CSP]: "report-uri /a" }), base({}, { [CSP]: "report-uri /b" })),
    ).toEqual([]);
  });
});

describe("script baseline diff: other security headers", () => {
  const diff = (name: string, before: string | undefined, after: string | undefined) =>
    brief(
      base({}, before === undefined ? {} : { [name]: before }),
      base({}, after === undefined ? {} : { [name]: after }),
    ).map((c) => c[2]);

  it("a header that is gone is reported for each of them", () => {
    for (const [name, value, shown] of [
      ["strict-transport-security", "max-age=300", "max-age=300"],
      ["x-content-type-options", "nosniff", "nosniff"],
      ["x-frame-options", "DENY", "deny"],
      ["referrer-policy", "no-referrer", "no-referrer"],
      ["permissions-policy", "camera=()", "camera=()"],
      ["cross-origin-opener-policy", "same-origin", "same-origin"],
    ] as const)
      expect(diff(name, value, undefined), name).toEqual([
        `${name} is no longer sent; last run it was ${shown}`,
      ]);
  });

  it("Strict-Transport-Security: a smaller max-age, includeSubDomains or preload dropped", () => {
    expect(
      diff(
        "strict-transport-security",
        "max-age=63072000; includeSubDomains; preload",
        "max-age=300; includeSubDomains; preload",
      ),
    ).toEqual(["strict-transport-security: max-age 63072000 -> 300"]);
    expect(
      diff(
        "strict-transport-security",
        "max-age=63072000; includeSubDomains; preload",
        "max-age=63072000",
      ),
    ).toEqual([
      "strict-transport-security: includesubdomains dropped",
      "strict-transport-security: preload dropped",
    ]);
    expect(
      diff("strict-transport-security", "max-age=300", "max-age=63072000; includeSubDomains"),
    ).toEqual([]);
  });

  it("X-Content-Type-Options, X-Frame-Options, Referrer-Policy and the Cross-Origin policies: less strict only", () => {
    expect(diff("x-content-type-options", "nosniff", "sniff")).toHaveLength(1);
    expect(diff("x-frame-options", "DENY", "SAMEORIGIN")).toEqual([
      "x-frame-options: sameorigin now, deny last run",
    ]);
    expect(diff("x-frame-options", "SAMEORIGIN", "DENY")).toEqual([]);
    expect(diff("referrer-policy", "no-referrer", "unsafe-url")).toEqual([
      "referrer-policy: unsafe-url now, no-referrer last run",
    ]);
    expect(diff("referrer-policy", "origin, strict-origin", "strict-origin")).toEqual([]);
    expect(diff("cross-origin-opener-policy", "same-origin", "unsafe-none")).toHaveLength(1);
    expect(diff("cross-origin-embedder-policy", "unsafe-none", "require-corp")).toEqual([]);
    expect(diff("cross-origin-resource-policy", "same-origin", "cross-origin")).toHaveLength(1);
  });

  it("Permissions-Policy: a feature removed or given a new origin; a feature added is not a change", () => {
    expect(
      diff("permissions-policy", "camera=(), geolocation=(self)", "camera=(self), geolocation=()"),
    ).toEqual(["permissions-policy: camera now allows self (last run: nothing)"]);
    expect(diff("permissions-policy", "camera=(), geolocation=(self)", "camera=()")).toEqual([
      "permissions-policy: geolocation is no longer set (last run: self)",
    ]);
    expect(diff("permissions-policy", "camera=()", "camera=(), microphone=(self)")).toEqual([]);
  });

  it("a header that appeared is not a change", () => {
    expect(diff("x-frame-options", undefined, "DENY")).toEqual([]);
  });
});
