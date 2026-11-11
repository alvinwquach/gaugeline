import { describe, expect, it } from "vitest";
import { buildRunSnapshot, type RunSnapshot } from "../../run-snapshot.js";
import type { CheckContext } from "../../model.js";
import { buildSnapshot } from "../../snapshot.js";
import { createPageRegistry } from "../index.js";
import {
  cspLoosened,
  scriptChanged,
  scriptKnownBadHost,
  securityHeaderLoosened,
} from "../script-baseline.js";

// Built at run time: no key-shaped string is in the repository.
const KEY = ["sk", "live", "BaselineCheckNotAKey00"].join("_");
const URL0 = "https://brightsmile-clinic.example/book";
const TAKEN = new Date("2026-11-11T09:00:00Z");

function page(body: string, headers: Record<string, string> = {}, type = "text/html") {
  return buildSnapshot([
    { url: URL0, status: 200, headers: { "content-type": type, ...headers }, body, ms: 1 },
  ]);
}
const html = (scripts: string) =>
  `<html><head><title>Book</title></head><body>${scripts}</body></html>`;

/** What a first run saves, read back from disk as the CLI does. */
const saved = (p: ReturnType<typeof page>): RunSnapshot =>
  JSON.parse(JSON.stringify(buildRunSnapshot(p, () => TAKEN))) as RunSnapshot;

const sent: string[] = [];
const ctxWith = (over: Partial<CheckContext> = {}): CheckContext => ({
  warn: () => undefined,
  couldNotCheck: (url, reason) => void sent.push(`${url} ${reason}`),
  ...over,
});

const STRIPE = `<script src="https://js.stripe.example/v3/" integrity="sha384-abc" crossorigin="anonymous"></script>`;
const CSP = "default-src 'self'; script-src 'self' https://js.stripe.example";

describe("script-known-bad-host", () => {
  it("polyfill.io is a high finding that names the host, the path, the date and the source", () => {
    const p = page(
      html(`<script src="https://cdn.polyfill.io/v3/polyfill.min.js?features=fetch"></script>`),
    );
    const found = scriptKnownBadHost.run(p, ctxWith()) as {
      severity: string;
      evidence: string;
      url: string;
    }[];
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("high");
    expect(found[0]?.url).toBe(URL0);
    expect(found[0]?.evidence).toContain("cdn.polyfill.io/v3/polyfill.min.js");
    expect(found[0]?.evidence).toContain("since 2024-06");
    expect(found[0]?.evidence).toContain("https://sansec.io/research/polyfill-supply-chain-attack");
    expect(found[0]?.evidence).not.toContain("features=fetch");
    // Its source was cited from memory, so it is proposed like the others.
    expect(found[0]?.evidence).toContain("This entry has not been confirmed by a maintainer");
    expect(found[0]?.evidence).not.toContain("suspended");
  });

  it("a proposed entry says it has not been confirmed", () => {
    const p = page(
      html(`<script src="https://cdn.bootcdn.net/ajax/libs/jquery/3.6.0/jquery.min.js"></script>`),
    );
    const found = scriptKnownBadHost.run(p, ctxWith()) as { evidence: string }[];
    expect(found[0]?.evidence).toContain("This entry has not been confirmed by a maintainer");
  });

  it("clean scripts, a host that only looks similar, the same script twice, and a non-HTML answer", () => {
    expect(
      scriptKnownBadHost.run(
        page(html(`${STRIPE}<script src="https://notpolyfill.io/a.js"></script>`)),
        ctxWith(),
      ),
    ).toEqual([]);
    const twice = html(
      `<script src="https://polyfill.io/a.js"></script><script src="https://polyfill.io/a.js?x=2"></script>`,
    );
    expect(scriptKnownBadHost.run(page(twice), ctxWith())).toHaveLength(1);
    expect(scriptKnownBadHost.run(page(twice, {}, "application/json"), ctxWith())).toEqual([]);
  });

  it("is in the default page registry, and so are the three change checks", () => {
    const ids = createPageRegistry()
      .all()
      .map((c) => c.id);
    for (const c of [scriptKnownBadHost, scriptChanged, cspLoosened, securityHeaderLoosened])
      expect(ids).toContain(c.id);
  });
});

describe("script-changed: a new script between runs", () => {
  it("reports the script added since the last run, with host and path only", () => {
    const before = page(html(STRIPE), { "content-security-policy": CSP });
    const after = page(
      html(`${STRIPE}<script src="https://cdn.chatwidget.example/loader.js?site=${KEY}"></script>`),
      { "content-security-policy": CSP },
    );
    const found = scriptChanged.run(after, ctxWith({ previous: saved(before) })) as {
      evidence: string;
      severity: string;
    }[];
    expect(found).toEqual([
      expect.objectContaining({
        severity: "medium",
        evidence:
          "cdn.chatwidget.example/loader.js is new since the last run (no integrity attribute)",
      }),
    ]);
    expect(JSON.stringify(saved(after))).not.toContain(KEY);
  });

  it("nothing changed gives nothing, and a script that lost its integrity attribute is reported", () => {
    const before = page(html(STRIPE));
    expect(scriptChanged.run(before, ctxWith({ previous: saved(before) }))).toEqual([]);
    const after = page(html(`<script src="https://js.stripe.example/v3/"></script>`));
    const found = scriptChanged.run(after, ctxWith({ previous: saved(before) })) as {
      evidence: string;
    }[];
    expect(found.map((f) => f.evidence)).toEqual([
      "js.stripe.example/v3/ has no integrity attribute now; last run it had one",
    ]);
  });

  it("at most 20 findings for one page", () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `<script src="https://s${i}.cdn.example/a.js"></script>`,
    ).join("");
    const found = scriptChanged.run(page(html(many)), ctxWith({ previous: saved(page(html(""))) }));
    expect(found).toHaveLength(20);
  });
});

describe("csp-loosened and security-header-loosened", () => {
  it("a CSP that adds unsafe-inline is a high finding with the directive named", () => {
    const before = page(html(STRIPE), { "content-security-policy": CSP });
    const after = page(html(STRIPE), { "content-security-policy": `${CSP} 'unsafe-inline'` });
    const found = cspLoosened.run(after, ctxWith({ previous: saved(before) })) as {
      severity: string;
      evidence: string;
    }[];
    expect(found).toEqual([
      expect.objectContaining({
        severity: "high",
        evidence:
          "content-security-policy: script-src now allows 'unsafe-inline'; last run it was 'self' https://js.stripe.example",
      }),
    ]);
    // The header checks are separate: nothing is said twice.
    expect(securityHeaderLoosened.run(after, ctxWith({ previous: saved(before) }))).toEqual([]);
  });

  it("a header dropped by a deploy is one finding per header, under the right check", () => {
    const before = page(html(STRIPE), {
      "content-security-policy": CSP,
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "x-content-type-options": "nosniff",
    });
    const after = page(html(STRIPE), { "x-content-type-options": "nosniff" });
    const ctx = ctxWith({ previous: saved(before) });
    expect((cspLoosened.run(after, ctx) as { evidence: string }[]).map((f) => f.evidence)).toEqual([
      "content-security-policy is no longer sent; last run it had 2 directives",
    ]);
    expect(
      (securityHeaderLoosened.run(after, ctx) as { evidence: string }[]).map((f) => f.evidence),
    ).toEqual([
      "strict-transport-security is no longer sent; last run it was max-age=63072000; includesubdomains",
    ]);
  });

  it("an answer that is not a page gives no finding", () => {
    const before = page(html(STRIPE), { "content-security-policy": CSP });
    const json = page("{}", {}, "application/json");
    expect(cspLoosened.run(json, ctxWith({ previous: saved(before) }))).toEqual([]);
  });
});

describe("the change checks without a comparison", () => {
  const checks = [scriptChanged, cspLoosened, securityHeaderLoosened];

  it("without --since last they say nothing and ask nothing", () => {
    sent.length = 0;
    for (const c of checks) expect(c.run(page(html(STRIPE)), ctxWith())).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("on a first run with --since last each is could not check, never a pass", () => {
    sent.length = 0;
    for (const c of checks)
      expect(c.run(page(html(STRIPE)), ctxWith({ baselineRequested: true }))).toEqual([]);
    expect(sent).toEqual(
      checks.map(
        () => `${URL0} no saved scripts and headers to compare with yet: this run saves them`,
      ),
    );
  });

  it("a snapshot saved before this existed, and a hand-edited one, are could not check", () => {
    sent.length = 0;
    const old = saved(page(html(STRIPE)));
    delete old.baseline;
    expect(
      scriptChanged.run(page(html(STRIPE)), ctxWith({ previous: old, baselineRequested: true })),
    ).toEqual([]);
    const broken = { ...old, baseline: { scripts: 5, headers: [] } } as unknown as RunSnapshot;
    expect(
      cspLoosened.run(page(html(STRIPE)), ctxWith({ previous: broken, baselineRequested: true })),
    ).toEqual([]);
    expect(sent).toEqual([
      `${URL0} the last run's snapshot has no saved scripts and headers: this run saves them`,
      `${URL0} the last run's saved scripts and headers could not be read: this run saves new ones`,
    ]);
  });
});

describe("what a snapshot keeps", () => {
  it("hosts, paths, integrity and header directives: no page text, query, nonce or key", () => {
    const p = page(
      html(
        `<p>Dr Rivera, 14 May, ${KEY}</p><script src="https://tags.example/gtm.js?id=${KEY}" nonce="n0nce"></script>`,
      ),
      {
        "content-security-policy": "script-src 'nonce-n0nce' 'self'",
        "set-cookie": `s=${KEY}`,
        authorization: KEY,
      },
    );
    const text = JSON.stringify(saved(p).baseline);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("Rivera");
    expect(text).not.toContain("n0nce");
    expect(saved(p).baseline?.scripts).toEqual({ "tags.example/gtm.js": { sri: false } });
  });
});

describe("a cut inventory is could not check, never silent (review finding 5)", () => {
  const many = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `<script src="https://s${i}.cdn.example/a.js"></script>`,
    ).join("");

  it("scripts past the limit are named by script-changed, from this run and from the saved one", () => {
    sent.length = 0;
    const big = page(html(many(203)));
    expect(scriptChanged.run(big, ctxWith({ previous: saved(big) }))).toEqual([]);
    expect(sent).toEqual([`${URL0} 3 third-party scripts past the first 200 are not compared`]);
    sent.length = 0;
    // Only the saved run was cut: the page now has few scripts, and the comparison still says so.
    void scriptChanged.run(page(html(many(2))), ctxWith({ previous: saved(big) }));
    expect(sent).toEqual([`${URL0} 3 third-party scripts past the first 200 are not compared`]);
  });

  it("a source list past the limit is named by csp-loosened, and not by the other checks", () => {
    sent.length = 0;
    const hosts = Array.from({ length: 505 }, (_, i) => `https://h${i}.example`).join(" ");
    const p = page(html(STRIPE), { "content-security-policy": `script-src ${hosts}` });
    void cspLoosened.run(p, ctxWith({ previous: saved(p) }));
    void scriptChanged.run(p, ctxWith({ previous: saved(p) }));
    expect(sent).toEqual([
      `${URL0} script-src has more than 500 sources: only the first 500 are compared`,
    ]);
  });
});

describe("a reporting address is never kept (review finding 1)", () => {
  it("report-uri's value is in no saved baseline, finding or could-not-check line", () => {
    sent.length = 0;
    const before = page(html(STRIPE), {
      "content-security-policy": `${CSP}; report-uri https://o1.ingest.sentry.example/api/2/security/?sentry_key=${KEY}`,
    });
    const after = page(html(STRIPE), {
      "content-security-policy": `${CSP} 'unsafe-inline'; report-uri https://o2.ingest.sentry.example/api/3/security/?sentry_key=${KEY}`,
    });
    const found = cspLoosened.run(after, ctxWith({ previous: saved(before) }));
    expect(JSON.stringify([saved(before), saved(after), found, sent])).not.toContain(KEY);
    expect(found).toHaveLength(1);
  });
});
