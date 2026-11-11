import { describe, expect, it } from "vitest";
import {
  type Observation,
  type PageRead,
  causesOf,
  compareVisits,
  cachingVerdict,
  lifetimeVerdict,
} from "../judge.js";

const obs = (body: string, headers: Record<string, string> = {}, status = 200): Observation => ({
  status,
  headers: { "content-type": "text/html", ...headers },
  body,
});

const read = (
  first: Observation,
  second: Observation,
  over: Partial<Extract<PageRead, { ok: true }>> = {},
): Extract<PageRead, { ok: true }> => ({
  ok: true,
  url: "https://marlowe-bar.example/specials",
  path: "/specials",
  markedStatic: false,
  first,
  second,
  gapMs: 3000,
  ...over,
});

describe("compareVisits", () => {
  it("is stable when the two bodies are the same", () => {
    expect(compareVisits(read(obs("<p>Menu</p>"), obs("<p>Menu</p>")))).toEqual({ kind: "stable" });
  });

  it("is stable when only a nonce and a CSRF value differ", () => {
    const a = obs('<script nonce="aaa"></script><meta name="csrf-token" content="1"><p>Menu</p>');
    const b = obs('<script nonce="bbb"></script><meta name="csrf-token" content="2"><p>Menu</p>');
    expect(compareVisits(read(a, b))).toEqual({ kind: "stable" });
  });

  it("changes when a timestamp differs, with the first difference and a plain sentence", () => {
    const v = compareVisits(
      read(obs("<p>Updated 2026-11-11T09:00:03Z</p>"), obs("<p>Updated 2026-11-11T09:00:08Z</p>")),
    );
    expect(v).toMatchObject({
      kind: "changes",
      cause: "time",
      sentence:
        "This page changes on every visit because it prints the current time; caching can't help it.",
    });
    if (v.kind === "changes") {
      expect(v.evidence).toContain('"2026-11-11T09:00:03Z"');
      expect(v.evidence).toContain('"2026-11-11T09:00:08Z"');
      expect(v.evidence).toContain("3 seconds apart");
      expect(v.evidence).toContain("Updated");
    }
  });

  it.each([
    [
      "id",
      '<div data-request="9f2c61ab77e04d1c"></div>',
      '<div data-request="31b0aa5e92c7f604"></div>',
      /prints a value that is new on every visit/,
    ],
    [
      "number",
      "<p>4120 visitors</p>",
      "<p>4121 visitors</p>",
      /prints a number that changes on every visit/,
    ],
    ["other", "<p>Open</p>", "<p>Closed</p>", /its HTML is different on two visits seconds apart/],
  ])("the %s sentence", (cause, a, b, sentence) => {
    const v = compareVisits(read(obs(a), obs(b)));
    expect(v).toMatchObject({ kind: "changes", cause });
    if (v.kind === "changes") expect(v.sentence).toMatch(sentence);
  });

  it("escapes invisible characters in the snippet and cuts long text", () => {
    const v = compareVisits(read(obs(`<p>a\u200Bb ${"x".repeat(500)}</p>`), obs("<p>c</p>")));
    if (v.kind !== "changes") throw new Error("expected a change");
    expect(v.evidence).not.toContain("\u200B");
    expect(v.evidence.length).toBeLessThan(500);
  });

  it("notes a cookie that looks like a test variant, and says both visits were sent without cookies", () => {
    const v = compareVisits(
      read(
        obs("<h1>Spring menu</h1>", { "set-cookie": "ab_variant=A; Path=/; Max-Age=600" }),
        obs("<h1>Summer menu</h1>", { "set-cookie": "ab_variant=B; Path=/; Max-Age=600" }),
      ),
    );
    if (v.kind !== "changes") throw new Error("expected a change");
    expect(v.evidence).toContain("ab_variant");
    expect(v.evidence).toMatch(/without cookies/);
  });

  it("does not note an ordinary cookie", () => {
    const v = compareVisits(
      read(
        obs("<p>a</p>", { "set-cookie": "session=1; Path=/" }),
        obs("<p>b</p>", { "set-cookie": "session=2" }),
      ),
    );
    if (v.kind !== "changes") throw new Error("expected a change");
    expect(v.evidence).not.toMatch(/cookie/);
  });

  it("a page that answers a cookie-chosen variant the same to a visitor with no cookie is stable", () => {
    const same = obs("<h1>Default menu</h1>", { "set-cookie": "ab_variant=A" });
    expect(compareVisits(read(same, same))).toEqual({ kind: "stable" });
  });

  it.each([
    [obs("<p>a</p>", {}, 404), obs("<p>a</p>"), /HTTP 404/],
    [obs("<p>a</p>"), obs("<p>a</p>", {}, 503), /HTTP 503/],
    [{ status: 200, headers: {} }, obs("<p>a</p>"), /no body/],
  ])("is unreadable, with the reason, when a visit did not give a page", (a, b, reason) => {
    const v = compareVisits(read(a, b));
    expect(v.kind).toBe("unreadable");
    if (v.kind === "unreadable") expect(v.reason).toMatch(reason);
  });
});

describe("cachingVerdict: only for pages marked static", () => {
  const marked = { markedStatic: true };
  const miss = obs("<p>a</p>", { "x-vercel-cache": "MISS" });
  const hit = obs("<p>a</p>", { "x-vercel-cache": "HIT" });

  it("is not applicable to a page that is not marked static", () => {
    expect(cachingVerdict(read(miss, miss))).toEqual({ kind: "not-applicable" });
  });

  it("a miss on both visits is never cached", () => {
    const v = cachingVerdict(read(miss, miss, marked));
    expect(v).toMatchObject({ kind: "never" });
    if (v.kind === "never") {
      expect(v.evidence).toContain("x-vercel-cache: MISS");
      expect(v.evidence).toContain("both visits");
      expect(v.sentence).toMatch(/never served from the CDN's cache/);
    }
  });

  it("a miss and then a hit is cached", () => {
    expect(cachingVerdict(read(miss, hit, marked))).toEqual({ kind: "cached" });
  });

  it("works on Cloudflare's header and on a bare age", () => {
    const cf = obs("<p>a</p>", { "cf-cache-status": "DYNAMIC" });
    expect(cachingVerdict(read(cf, cf, marked)).kind).toBe("never");
    const aged = obs("<p>a</p>", { age: "30" });
    expect(cachingVerdict(read(miss, aged, marked)).kind).toBe("cached");
  });

  it("with no cache header on the second visit it cannot tell", () => {
    const v = cachingVerdict(read(miss, obs("<p>a</p>"), marked));
    expect(v.kind).toBe("unknown");
    if (v.kind === "unknown") expect(v.reason).toMatch(/x-vercel-cache, cf-cache-status or age/);
  });

  it("is unreadable-as-unknown when a visit did not answer 2xx", () => {
    expect(cachingVerdict(read(miss, obs("x", {}, 500), marked)).kind).toBe("unknown");
  });
});

describe("lifetimeVerdict: a lifetime under the minimum, on a page marked static", () => {
  const marked = { markedStatic: true };
  const cc = (value: string, extra: Record<string, string> = {}) =>
    obs("<p>a</p>", { "cache-control": value, ...extra });

  it("is not applicable to a page that is not marked static", () => {
    expect(lifetimeVerdict(read(cc("public, s-maxage=1"), cc("public, s-maxage=1")), 60)).toEqual({
      kind: "not-applicable",
    });
  });

  it("flags s-maxage=1 against a minimum of 60", () => {
    const v = lifetimeVerdict(
      read(
        cc("public, s-maxage=1, stale-while-revalidate=59"),
        cc("public, s-maxage=1, stale-while-revalidate=59"),
        marked,
      ),
      60,
    );
    expect(v).toMatchObject({ kind: "short", seconds: 1 });
    if (v.kind === "short") {
      expect(v.evidence).toContain("s-maxage=1");
      expect(v.evidence).toContain("minimum of 60 seconds");
      expect(v.sentence).toMatch(/rebuilds it about every second/);
    }
  });

  it("the minimum is inclusive: a lifetime equal to it is fine", () => {
    expect(
      lifetimeVerdict(read(cc("public, s-maxage=60"), cc("public, s-maxage=60"), marked), 60).kind,
    ).toBe("fine");
    expect(
      lifetimeVerdict(read(cc("public, s-maxage=59"), cc("public, s-maxage=59"), marked), 60).kind,
    ).toBe("short");
  });

  it("Vercel's own max-age=0 on a page its CDN serves from cache is fine: it keeps it until the next deploy", () => {
    const v = lifetimeVerdict(
      read(
        cc("public, max-age=0, must-revalidate", { "x-vercel-cache": "MISS" }),
        cc("public, max-age=0, must-revalidate", { "x-vercel-cache": "HIT" }),
        marked,
      ),
      60,
    );
    expect(v.kind).toBe("fine");
  });

  it("max-age=0 on a page the CDN never serves from cache is short", () => {
    const m = cc("public, max-age=0, must-revalidate", { "x-vercel-cache": "MISS" });
    expect(lifetimeVerdict(read(m, m, marked), 60).kind).toBe("short");
  });

  it("no-store is short", () => {
    const n = cc("private, no-store");
    expect(lifetimeVerdict(read(n, n, marked), 60)).toMatchObject({ kind: "short", seconds: 0 });
  });

  it("no Cache-Control header gives no lifetime to judge", () => {
    const v = lifetimeVerdict(read(obs("x"), obs("x"), marked), 60);
    expect(v.kind).toBe("unknown");
    if (v.kind === "unknown") expect(v.reason).toMatch(/no Cache-Control/);
  });
});

describe("causesOf: the likeliest cause of cost on a page, first", () => {
  const marked = { markedStatic: true };

  it("a changing page comes before a short lifetime, and one cause is named once", () => {
    const miss = obs("<p>a 1</p>", {
      "x-vercel-cache": "MISS",
      "cache-control": "public, s-maxage=1",
    });
    const miss2 = obs("<p>a 2</p>", {
      "x-vercel-cache": "MISS",
      "cache-control": "public, s-maxage=1",
    });
    // Both visits missed because the lifetime is one second: the lifetime is the cause, not "never cached".
    expect(causesOf(read(miss, miss2, marked), 60).map((c) => c.id)).toEqual([
      "output-changes-every-request",
      "revalidate-too-often",
    ]);
  });

  it("a page that tells caches not to keep it is never cached, not also a short lifetime", () => {
    const n = obs("<p>a</p>", { "x-vercel-cache": "MISS", "cache-control": "private, no-store" });
    expect(causesOf(read(n, n, marked), 60).map((c) => c.id)).toEqual(["never-cached"]);
  });

  it("a short lifetime with no cache header to read is a short lifetime", () => {
    const n = obs("<p>a</p>", { "cache-control": "public, max-age=0, s-maxage=0" });
    expect(causesOf(read(n, n, marked), 60).map((c) => c.id)).toEqual(["revalidate-too-often"]);
  });

  it("is empty for a stable, cached page", () => {
    const hit = obs("<p>a</p>", {
      "x-vercel-cache": "HIT",
      "cache-control": "public, s-maxage=3600",
    });
    expect(causesOf(read(hit, hit, marked), 60)).toEqual([]);
  });

  it("every cause has a severity, a plain sentence and the evidence", () => {
    const miss = obs("<p>a 1</p>", { "x-vercel-cache": "MISS" });
    const [cause] = causesOf(
      read(miss, obs("<p>a 2</p>", { "x-vercel-cache": "MISS" }), marked),
      60,
    );
    expect(cause).toMatchObject({ id: "output-changes-every-request", severity: "medium" });
    expect(cause?.sentence.endsWith(".")).toBe(true);
    expect(cause?.evidence.length).toBeGreaterThan(10);
  });
});
