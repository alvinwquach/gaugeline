import { describe, expect, it } from "vitest";
import { diffBaselines } from "../diff.js";
import {
  BASELINE_LIMITS,
  buildBaseline,
  parseCsp,
  parseHeader,
  readBaseline,
  type Cut,
  type ScriptBaseline,
} from "../inventory.js";
import { buildSnapshot } from "../../snapshot.js";

// Built at run time: no key-shaped string is in the repository.
const KEY = ["sk", "live", "ReviewTestNotAKey0000"].join("_");
const CSP = "content-security-policy";

const base = (headers: Record<string, string>): ScriptBaseline => ({
  scripts: {},
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, parseHeader(k, v)])),
});
const csp = (before: string, after: string) =>
  diffBaselines(base({ [CSP]: before }), base({ [CSP]: after })).map((c) => [
    c.severity,
    c.evidence.replace("content-security-policy: ", ""),
  ]);

describe("review 1: report-uri and report-to values are never kept", () => {
  it("keeps the directive and drops its value, so a key in a reporting address is not saved", () => {
    const d = parseCsp(
      `script-src 'self'; report-uri https://o1.ingest.sentry.example/api/2/security/?sentry_key=${KEY}; report-to csp-group`,
    );
    expect(d["report-uri"]).toEqual([]);
    expect(d["report-to"]).toEqual([]);
    const p = buildSnapshot([
      {
        url: "https://clinic.example/",
        status: 200,
        headers: {
          "content-type": "text/html",
          [CSP]: `script-src 'self'; report-uri https://o1.ingest.sentry.example/x?sentry_key=${KEY}`,
          "x-frame-options": `ALLOW-FROM https://x.example/?k=${KEY}`,
          "referrer-policy": `no-referrer?k=${KEY}`,
        },
        body: "<p>hi</p>",
        ms: 1,
      },
    ]);
    expect(JSON.stringify(buildBaseline(p))).not.toContain(KEY);
  });

  it("a source never keeps a query, a fragment or userinfo", () => {
    const d = parseCsp(`script-src https://user:${KEY}@cdn.example/a.js?k=${KEY}#f`);
    expect(JSON.stringify(d)).not.toContain(KEY);
    expect(d["script-src"]).toEqual(["https://cdn.example/a.js"]);
  });
});

describe("review 2: the effective policy is compared, not the directive lists", () => {
  it("a new script-src with * and 'unsafe-inline' over a default-src is high", () => {
    expect(csp("default-src 'self'", "default-src 'self'; script-src * 'unsafe-inline'")).toEqual([
      [
        "high",
        "script-src now allows * 'unsafe-inline'; last run it was 'self' (from default-src)",
      ],
    ]);
  });

  it("a new script-src-elem overrides script-src", () => {
    expect(csp("script-src 'self'", "script-src 'self'; script-src-elem 'unsafe-inline'")).toEqual([
      [
        "high",
        "script-src-elem now allows 'unsafe-inline'; last run it was 'self' (from script-src)",
      ],
    ]);
  });

  it("removing script-src while default-src covers it with the same sources is not a change", () => {
    expect(csp("default-src 'self'; script-src 'self'", "default-src 'self'")).toEqual([]);
  });

  it("removing script-src so a looser default-src applies is reported", () => {
    expect(csp("default-src *; script-src 'self'", "default-src *")).toEqual([
      ["high", "script-src now allows *; last run it was 'self'"],
    ]);
  });

  it("loosening default-src is one finding, not one per directive that falls back to it", () => {
    expect(csp("default-src 'self'", "default-src 'self' https://cdn.example")).toEqual([
      ["medium", "default-src now allows https://cdn.example; last run it was 'self'"],
    ]);
  });

  it("frame-src falls back through child-src; worker-src through child-src, script-src, default-src", () => {
    expect(csp("child-src 'self'", "child-src 'self'; frame-src https://video.example")).toEqual([
      [
        "medium",
        "frame-src now allows https://video.example; last run it was 'self' (from child-src)",
      ],
    ]);
    expect(csp("script-src 'self'", "script-src 'self'; worker-src blob:")).toEqual([
      ["medium", "worker-src now allows blob:; last run it was 'self' (from script-src)"],
    ]);
  });

  it("a new directive that is no looser than what applied is not a change", () => {
    expect(csp("default-src 'self'", "default-src 'self'; img-src 'self'")).toEqual([]);
  });
});

describe("review 3: sources are compared as sources", () => {
  const same = (a: string, b: string) =>
    expect(csp(`script-src ${a}`, `script-src ${b}`)).toEqual([]);
  const looser = (a: string, b: string) =>
    expect(csp(`script-src ${a}`, `script-src ${b}`).map((c) => c[0])).not.toEqual([]);

  it("'none' is never added", () => {
    same("'self'", "'none'");
    same("'none'", "'none'");
  });

  it("a listed host under a wildcard, the same host with a scheme, and a path under a host are narrowing", () => {
    same("https://*.example.com", "https://cdn.example.com");
    same("https://*.example.com", "https://a.b.example.com");
    same("example.com", "https://example.com");
    same("http://example.com", "https://example.com");
    same("https://x.example/js/", "https://x.example/js/a.js");
    same("https://x.example:*", "https://x.example:8443");
    same("https://x.example:443", "https://x.example");
    same("*", "https://x.example 'self'");
    same("https:", "https://x.example");
  });

  it("a wider host, a new port, a shorter path, the apex of a wildcard and a new scheme are looser", () => {
    looser("https://cdn.example.com", "https://*.example.com");
    looser("https://example.com", "https://example.com:8443");
    looser("https://x.example/js/a.js", "https://x.example/js/");
    looser("https://x.example/js/", "https://x.example/");
    looser("https://*.example.com", "https://example.com");
    looser("https://x.example", "http://x.example");
    looser("https://x.example", "https://y.example");
    looser("'self'", "data:");
    looser("https://x.example", "'unsafe-eval'");
  });
});

describe("review 4: nonces and hashes make 'unsafe-inline' do nothing", () => {
  it("a nonce policy that drops the nonce and keeps 'unsafe-inline' now allows inline code", () => {
    expect(csp("script-src 'nonce-a' 'unsafe-inline'", "script-src 'unsafe-inline'")).toEqual([
      [
        "high",
        "script-src now allows 'unsafe-inline'; last run it was 'nonce-or-hash' 'unsafe-inline'",
      ],
    ]);
  });

  it("adding 'unsafe-inline' beside a nonce or a hash is not a change", () => {
    expect(
      csp("script-src 'self' 'nonce-a'", "script-src 'self' 'nonce-b' 'unsafe-inline'"),
    ).toEqual([]);
    expect(csp("script-src 'sha256-aaa'", "script-src 'sha256-aaa' 'unsafe-inline'")).toEqual([]);
  });

  it("adding 'unsafe-inline' with no nonce is high", () => {
    expect(csp("script-src 'self'", "script-src 'self' 'unsafe-inline'")[0]?.[0]).toBe("high");
  });
});

describe("review 5: a cut is never silent", () => {
  it("a directive with more sources than are kept says so, in the baseline", () => {
    const cuts: Cut[] = [];
    const sources = Array.from(
      { length: BASELINE_LIMITS.values + 5 },
      (_, i) => `https://h${i}.example`,
    );
    const d = parseCsp(`script-src ${sources.join(" ")}`, cuts);
    expect(d["script-src"]).toHaveLength(BASELINE_LIMITS.values);
    expect(cuts).toEqual([
      {
        check: "csp-loosened",
        reason: `script-src has more than ${BASELINE_LIMITS.values} sources: only the first ${BASELINE_LIMITS.values} are compared`,
      },
    ]);
  });

  it("the limits are well above what a real policy holds", () => {
    expect(BASELINE_LIMITS.values).toBeGreaterThanOrEqual(500);
    expect(BASELINE_LIMITS.scripts).toBeGreaterThanOrEqual(200);
  });

  it("buildBaseline lists the cut for scripts and for directives", () => {
    const many = Array.from(
      { length: BASELINE_LIMITS.scripts + 3 },
      (_, i) => `<script src="https://s${i}.cdn.example/a.js"></script>`,
    ).join("");
    const b = buildBaseline(
      buildSnapshot([
        {
          url: "https://clinic.example/",
          status: 200,
          headers: { "content-type": "text/html" },
          body: many,
          ms: 1,
        },
      ]),
    );
    expect(Object.keys(b.scripts)).toHaveLength(BASELINE_LIMITS.scripts);
    expect(b.cut).toEqual([
      {
        check: "script-changed",
        reason: `3 third-party scripts past the first ${BASELINE_LIMITS.scripts} are not compared`,
      },
    ]);
  });
});

describe("review 7: a hand-edited state file", () => {
  it("readBaseline refuses a file with more than the limits hold, and one with a cut that is not a list", () => {
    const tooMany = {
      scripts: {},
      headers: { [CSP]: { "script-src": Array.from({ length: 5000 }, () => "a") } },
    };
    expect(readBaseline(tooMany)).toBeUndefined();
    const manyScripts = Object.fromEntries(
      Array.from({ length: 1500 }, (_, i) => [`h${i}.example/a.js`, { sri: false }]),
    );
    expect(readBaseline({ scripts: manyScripts, headers: {} })).toBeUndefined();
    expect(
      readBaseline({ scripts: {}, headers: { x: { "": ["a".repeat(2000)] } } }),
    ).toBeUndefined();
    expect(readBaseline({ scripts: {}, headers: {}, cut: "no" })).toBeUndefined();
  });

  it("control characters in stored names and sources never reach the evidence", () => {
    const evil = "script-src\u001b[31m";
    const prev: ScriptBaseline = { scripts: {}, headers: { [CSP]: { [evil]: ["'self'"] } } };
    const next: ScriptBaseline = {
      scripts: { "a.example/\u0007x.js": { sri: false } },
      headers: { [CSP]: { [evil]: ["'self'", "https://x.example\u001b[0m"] } },
    };
    const text = diffBaselines(prev, next)
      .map((c) => c.evidence)
      .join(" | ");
    // eslint-disable-next-line no-control-regex -- the test is that none are left
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(text).toContain("x.example");
  });
});

describe("review 8: a quoted HSTS max-age", () => {
  it('max-age="300" reads as 300, so a lowered value is flagged', () => {
    const d = (v: string) => base({ "strict-transport-security": v });
    expect(
      diffBaselines(
        d('max-age="31536000"; includeSubDomains'),
        d('max-age="300"; includeSubDomains'),
      ).map((c) => c.evidence),
    ).toEqual(["strict-transport-security: max-age 31536000 -> 300"]);
    expect(diffBaselines(d("max-age=31536000"), d("max-age=junk")).map((c) => c.evidence)).toEqual([
      "strict-transport-security: max-age 31536000 -> 0",
    ]);
  });
});
