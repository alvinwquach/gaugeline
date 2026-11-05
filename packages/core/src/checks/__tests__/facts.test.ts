import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { findFact } from "../../facts/extract.js";
import {
  normaliseAmount,
  normaliseHandle,
  normalisePhone,
  parseTimeRange,
} from "../../facts/normalise.js";
import { factsConfigSchema, type Fact, type FactsConfig } from "../../facts/types.js";
import { createFetcher, createNetworkTransport, type Transport } from "../../fetcher.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { compareFact, factsMatch } from "../facts-match.js";
import { factsPresent } from "../facts-present.js";

const FACT_CHECKS = ["facts-match", "facts-present", "facts-payment-link"];

function snap(path: string, body: string) {
  return buildSnapshot([
    {
      url: `https://tamal.example${path}`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

/** Local fixtures go to the network transport; payment profiles get a fixed answer, never the real site. */
function withPaymentHosts(answer: (url: URL) => number): Transport {
  const local = createNetworkTransport({ allowPrivate: true });
  return async (url, req) => {
    if (/(?:^|\.)(?:venmo\.com|cash\.app)$/.test(url.hostname)) {
      return {
        status: answer(url),
        headers: { "content-type": "text/html" },
        body: Readable.from([Buffer.from("")]),
      };
    }
    return local(url, req);
  };
}

describe("facts: unit (comparison tables)", () => {
  const price: Fact = { id: "p", kind: "price", item: "Tamal box", value: "$5" };
  it.each([
    ["$5", "same"],
    ["$5.00", "same"],
    ["5 USD", "same"],
    ["$5.50", "different"],
    ["$6", "different"],
    ["free", "unchecked"],
  ])("price $5 vs %s -> %s", (raw, verdict) => {
    expect(compareFact(price, raw, "text")).toBe(verdict);
  });

  it.each([
    ["5pm", "17:00"],
    ["5:00 PM", "17:00"],
    ["17:00", "17:00"],
  ])("time %s -> %s", (raw, hhmm) => {
    expect(parseTimeRange(`${raw}-9pm`)).toBe(`${hhmm}-21:00`);
  });
  it("hours: per-day comparison, conservative", () => {
    const hours: Fact = { id: "h", kind: "hours", value: "Fri 5pm-9pm" };
    expect(compareFact(hours, "Fri 5:00 PM - 9:00 PM", "text")).toBe("same");
    expect(compareFact(hours, "Fri 5pm-8pm", "text")).toBe("different");
    expect(compareFact(hours, "Saturday 5pm-9pm", "text")).toBe("unchecked");
    expect(compareFact(hours, '{"fri":"17:00-21:00"}', "structured data")).toBe("same");
  });

  it.each([
    ["(503) 555-0142", "same"],
    ["+1 503-555-0142", "same"],
    ["503.555.0142", "same"],
    ["503-555-0199", "different"],
    ["555-01", "unchecked"],
  ])("phone (503) 555-0142 vs %s -> %s", (raw, verdict) => {
    expect(compareFact({ id: "t", kind: "phone", value: "(503) 555-0142" }, raw, "text")).toBe(
      verdict,
    );
  });

  it.each([
    ["@marigold-tamales", "same"],
    ["@Marigold-Tamales", "same"],
    ["marigold-tamales", "same"],
    ["@marigold-tamale", "different"],
  ])("handle @marigold-tamales vs %s -> %s", (raw, verdict) => {
    expect(
      compareFact(
        { id: "v", kind: "handle", service: "venmo", value: "@marigold-tamales" },
        raw,
        "link",
      ),
    ).toBe(verdict);
  });

  it("normalisers return undefined for what they can't read", () => {
    expect([normaliseAmount("$1,200.50"), normaliseAmount("no price")]).toEqual([
      120050,
      undefined,
    ]);
    expect([normaliseHandle("$Marigold"), normaliseHandle("@ ")]).toEqual(["marigold", undefined]);
    expect(normalisePhone("call us")).toBeUndefined();
  });

  it("the facts config schema accepts each kind and rejects an unknown one", () => {
    expect(
      factsConfigSchema.safeParse({ facts: [{ id: "x", kind: "phone", value: "1" }] }).success,
    ).toBe(true);
    expect(
      factsConfigSchema.safeParse({ facts: [{ id: "x", kind: "email", value: "1" }] }).success,
    ).toBe(false);
  });
});

describe("facts: integration (the popup fixture)", () => {
  it("one wrong handle and one stale hours block in JSON-LD: fix-first findings naming both pages and both values", async () => {
    const site = await startFixture("popup");
    try {
      const facts = factsConfigSchema.parse(
        JSON.parse(readFileSync(`${SITES_DIR}popup/gaugeline.facts.json`, "utf8")),
      );
      const fetcher = createFetcher({ transport: withPaymentHosts(() => 200), timeoutMs: 5000 });
      const { result } = await checkSite({
        address: site.origin,
        fetcher,
        only: FACT_CHECKS,
        facts,
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        [
          "facts-match",
          "high",
          'hours: declared "Fri 5pm-9pm; Sat 5pm-9pm", as on /; / has "{"fri":"17:00-20:00","sat":"17:00-21:00"}" (structured data)',
        ],
        [
          "facts-match",
          "high",
          'venmo: declared "@marigold-tamales", as on /; /menu has "@Marigold-Tamale" (text)',
        ],
        [
          "facts-present",
          "medium",
          'pickup ("Pick up at the side window") is not on /order: it is only in an image description',
        ],
      ]);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("a payment link that answers 404 is facts-payment-link; only the profile address is requested", async () => {
    const site = await startFixture("popup");
    const asked: string[] = [];
    try {
      const facts: FactsConfig = {
        facts: [{ id: "phone", kind: "phone", value: "(503) 555-0142" }],
      };
      const fetcher = createFetcher({
        transport: withPaymentHosts((u) => {
          asked.push(u.href);
          return 404;
        }),
        timeoutMs: 5000,
      });
      const { result } = await checkSite({
        address: site.origin,
        fetcher,
        only: ["facts-payment-link"],
        facts,
      });
      expect(result.findings[0]?.evidence).toBe(
        "https://venmo.com/u/marigold-tamales on / returned 404",
      );
      expect([...new Set(asked)]).toEqual(["https://venmo.com/u/marigold-tamales"]);
    } finally {
      await site.close();
    }
  });
});

describe("facts: edge cases", () => {
  it("a fact that appears only in an image description is not present (and the evidence says so)", async () => {
    const p = snap(
      "/order",
      '<img src="/w.png" alt="Pick up at the side window"><p>Order ahead.</p>',
    );
    const facts: FactsConfig = {
      facts: [
        {
          id: "pickup",
          kind: "text",
          value: "Pick up at the side window",
          mustAppearOn: ["/order"],
        },
      ],
    };
    expect(findFact(p, facts.facts[0] as Fact)).toEqual([
      { path: "/order", source: "image description", raw: "Pick up at the side window" },
    ]);
    const found = await factsPresent.run(p, {
      warn: () => undefined,
      facts,
      pages: async () => [p],
    });
    expect(found[0]?.evidence).toContain("only in an image description");
  });

  it("two prices for two sizes of one item, declared as variants, are not a mismatch", async () => {
    const p = snap("/menu", "<p>Tamal box $12 · Tamal box (half) $7 · Atole $3</p>");
    const facts: FactsConfig = {
      facts: [
        {
          id: "box",
          kind: "price",
          item: "Tamal box",
          value: "$12.00",
          variants: [{ name: "Tamal box (half)", value: "$7" }],
        },
      ],
    };
    expect(findFact(p, facts.facts[0] as Fact).map((o) => o.raw)).toEqual(["$12"]);
    expect(
      await factsMatch.run(p, { warn: () => undefined, facts, pages: async () => [p] }),
    ).toEqual([]);
  });

  it("a handle written in different letter case is the same handle", async () => {
    const p = snap(
      "/",
      '<a href="https://venmo.com/MARIGOLD-Tamales">Pay</a> <p>Venmo: @Marigold-Tamales</p>',
    );
    const facts: FactsConfig = {
      facts: [{ id: "venmo", kind: "handle", service: "venmo", value: "@marigold-tamales" }],
    };
    expect(findFact(p, facts.facts[0] as Fact)).toHaveLength(2);
    expect(
      await factsMatch.run(p, { warn: () => undefined, facts, pages: async () => [p] }),
    ).toEqual([]);
  });

  it("a value that can't be parsed is unchecked: a warning, not a finding", async () => {
    const p = snap("/", "<p>Open Fri 5ish-late.</p>");
    const warnings: string[] = [];
    const facts: FactsConfig = { facts: [{ id: "hours", kind: "hours", value: "Fri 5pm-9pm" }] };
    expect(
      await factsMatch.run(p, {
        warn: (m: string) => warnings.push(m),
        facts,
        pages: async () => [p],
      }),
    ).toEqual([]);
  });

  it("with no declared facts, nothing is read", async () => {
    expect(await factsMatch.run(snap("/", "<p>x</p>"), { warn: () => undefined })).toEqual([]);
  });
});
