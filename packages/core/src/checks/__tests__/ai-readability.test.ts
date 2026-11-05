import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { AI_AGENTS, staleAgents, type AiAgent } from "../../ai-agents.js";
import { addressParts, businessFromJsonLd } from "../../facts/business.js";
import {
  hoursDisagree,
  normalisePhone,
  parseDays,
  parseHoursText,
  parseTime,
  parseTimeRange,
} from "../../facts/normalise.js";
import { createFetcher } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import { llmsFacts, parseLlmsTxt } from "../../llms.js";
import { hasOwnGroup, isAllowed, parseRobots } from "../../robots.js";
import { checkSite } from "../../site.js";
import { buildSiteContext, type SiteContext } from "../../site-context.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { aiCrawlersBlocked } from "../ai-crawlers-blocked.js";
import { llmsTxtStaleFacts } from "../llms-txt-stale-facts.js";
import { quotableFactsDisagree, sameName } from "../quotable-facts-disagree.js";
import { page } from "./helpers.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const warn = () => undefined;

function send(body: string, type: string, status = 200) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(status, { "content-type": type }).end(body);
  };
}

async function contextFor(routes: Parameters<typeof startServer>[0]): Promise<{
  site: SiteContext;
  finalUrl: string;
}> {
  const server = await startServer(routes);
  servers.push(server);
  const finalUrl = `${server.origin}/`;
  const site = await buildSiteContext({
    page: page({ finalUrl }),
    fetcher: createFetcher({ allowPrivate: true, timeoutMs: 5000 }),
    budget: createBudget(),
  });
  return { site, finalUrl };
}

async function runOn(fixture: string) {
  const site = await startFixture(fixture);
  try {
    const fetcher = createFetcher({ hosts: site.hosts, allowPrivate: true, timeoutMs: 5000 });
    const run = await checkSite({ address: site.origin, fetcher });
    return { ...run, hits: site.hits, origin: site.origin };
  } finally {
    await site.close();
  }
}

const BAKERY_LD = {
  "@context": "https://schema.org",
  "@type": "Bakery",
  name: "Hollyhock Bakery",
  telephone: "+1 503-555-0142",
  address: { streetAddress: "214 Quince Street", addressLocality: "Fernvale", postalCode: "97999" },
  openingHours: ["Mo-Fr 07:00-15:00", "Sa 08:00-14:00"],
};

describe("robots per AI user agent: unit", () => {
  const robots = parseRobots(
    [
      "User-agent: GPTBot",
      "Disallow: /private",
      "Allow: /private/menu",
      "",
      "User-agent: *",
      "Disallow: /*.pdf$",
      "Disallow: /drafts/",
    ].join("\n"),
  );
  it.each([
    ["GPTBot", "/", true],
    ["GPTBot", "/private/notes", false],
    ["GPTBot", "/private/menu/today", true],
    // GPTBot has its own group, so the * rules do not apply to it.
    ["GPTBot", "/menu.pdf", true],
    ["ClaudeBot", "/menu.pdf", false],
    ["ClaudeBot", "/menu.pdf?x=1", true],
    ["ClaudeBot", "/drafts/a", false],
    ["claudebot", "/private/notes", true],
  ])("%s %s -> allowed %s", (agent, path, allowed) => {
    expect(isAllowed(robots, agent, path)).toBe(allowed);
  });
  it("a group naming the token is its own; * is not", () => {
    expect(hasOwnGroup(robots, "gptbot")).toBe(true);
    expect(hasOwnGroup(robots, "ClaudeBot")).toBe(false);
  });
});

describe("llms.txt parsing: unit", () => {
  const file = parseLlmsTxt(
    [
      "\uFEFF# Hollyhock Bakery",
      "",
      "> An invented bakery.",
      "> Bread and cakes.",
      "",
      "Some notes before any section. [Not a section link](https://tea.example/x)",
      "",
      "## Visit",
      "",
      "- [Menu](https://hollyhock.test/menu): what is baked each day",
      "- [Map](<https://hollyhock.test/map>)",
      "",
      "```",
      "- [In a code block](https://hollyhock.test/code)",
      "```",
      "",
      "## Optional",
      "* [Story](/story): how it started",
    ].join("\r\n"),
  );
  it("reads the title, the blockquote summary and the H2 link sections", () => {
    expect(file.title).toBe("Hollyhock Bakery");
    expect(file.summary).toBe("An invented bakery. Bread and cakes.");
    expect(file.sections.map((s) => s.heading)).toEqual(["Visit", "Optional"]);
    expect(file.sections[0]?.links).toEqual([
      {
        title: "Menu",
        url: "https://hollyhock.test/menu",
        notes: "what is baked each day",
        section: "Visit",
      },
      { title: "Map", url: "https://hollyhock.test/map", section: "Visit" },
    ]);
    expect(file.sections[1]?.links).toEqual([
      { title: "Story", url: "/story", notes: "how it started", section: "Optional" },
    ]);
  });
  it("facts: only labelled phone numbers, an Address line and day-time pairs", () => {
    const facts = llmsFacts(
      parseLlmsTxt(
        [
          "# Hollyhock Bakery",
          "Founded 2019-04-12, order 4471-2093.",
          "Call us: (503) 555-0119 or [text us](tel:+15035550120)",
          "**Address:** 214 Quince Street, Fernvale, OR 97999",
          "Open Mon–Fri 7am–3pm and Sat 8:00 AM - 1:00 PM. Sunday: closed.",
        ].join("\n"),
      ),
    );
    expect(facts.phones.map((p) => p.digits)).toEqual(["5035550120", "5035550119"]);
    expect(facts.streetNumber).toBe("214");
    expect(facts.zip).toBe("97999");
    expect(facts.hours).toEqual({
      mon: "07:00-15:00",
      tue: "07:00-15:00",
      wed: "07:00-15:00",
      thu: "07:00-15:00",
      fri: "07:00-15:00",
      sat: "08:00-13:00",
      sun: "closed",
    });
  });
});

describe("phone and hours normalisation (shared with X23): unit", () => {
  it.each([
    ["+1 (503) 555-0142", "5035550142"],
    ["503.555.0142", "5035550142"],
    ["1-503-555-0142", "5035550142"],
    ["tel:+15035550142", "5035550142"],
    ["+44 20 7946 0958", "442079460958"],
    ["555-01", undefined],
    ["1234567890123456", undefined],
  ])("phone %s -> %s", (input, out) => {
    expect(normalisePhone(input)).toBe(out);
  });

  it.each([
    ["5pm", 17 * 60],
    ["5:00 PM", 17 * 60],
    ["17:00", 17 * 60],
    ["09:00:00", 9 * 60],
    ["12am", 0],
    ["12pm", 12 * 60],
    ["noon", 12 * 60],
    ["7 a.m.", 7 * 60],
    ["9", undefined],
    ["13pm", undefined],
    ["9:75", undefined],
  ])("time %s -> %s", (input, out) => {
    expect(parseTime(input)).toBe(out);
  });

  it("days and ranges: Mon-Fri, Sat & Sun, Fri to Mon (wraps), schema.org names", () => {
    expect(parseDays("Mon-Fri")).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(parseDays("Sat & Sun")).toEqual(["sat", "sun"]);
    expect(parseDays("Fri to Mon")).toEqual(["fri", "sat", "sun", "mon"]);
    expect(parseDays("https://schema.org/Saturday")).toEqual(["sat"]);
    expect(parseDays("Funday")).toBeUndefined();
    expect(parseTimeRange("9am – 5pm")).toBe("09:00-17:00");
    expect(parseTimeRange("Closed")).toBe("closed");
    expect(parseTimeRange("9-5")).toBeUndefined();
  });

  it('"5pm" equals "5:00 PM" and "17:00"; a day given two different ways is left out', () => {
    const a = parseHoursText("Mon 9am-5pm");
    const b = parseHoursText("Monday: 9:00 AM – 5:00 PM");
    const c = parseHoursText("Mo 09:00-17:00");
    expect(hoursDisagree(a, b)).toEqual([]);
    expect(hoursDisagree(a, c)).toEqual([]);
    expect(parseHoursText("Mon 9am-5pm. Mon 10am-6pm.")).toEqual({});
  });

  it("JSON-LD: openingHours strings, openingHoursSpecification, 00:00-00:00 is closed", () => {
    expect(businessFromJsonLd(page({ jsonLd: [BAKERY_LD] }))).toMatchObject({
      name: "Hollyhock Bakery",
      phone: "5035550142",
      streetNumber: "214",
      zip: "97999",
      hours: { mon: "07:00-15:00", fri: "07:00-15:00", sat: "08:00-14:00" },
    });
    const spec = businessFromJsonLd(
      page({
        jsonLd: [
          {
            "@type": "Cafe",
            openingHoursSpecification: [
              { dayOfWeek: "https://schema.org/Sunday", opens: "00:00", closes: "00:00" },
              { dayOfWeek: ["Saturday"], opens: "08:00:00", closes: "13:30:00" },
            ],
          },
        ],
      }),
    );
    expect(spec?.hours).toEqual({ sun: "closed", sat: "08:00-13:30" });
    expect(
      businessFromJsonLd(page({ jsonLd: [{ "@type": "WebSite", name: "x" }] })),
    ).toBeUndefined();
  });

  it("address parts: a house number is not a ZIP", () => {
    expect(addressParts("12345 Orchard Road")).toEqual({ streetNumber: "12345" });
    expect(addressParts("214B Quince Street, Fernvale, OR 97999-1234")).toEqual({
      streetNumber: "214B",
      zip: "97999",
    });
  });
});

describe("AI readability: integration (fixture sites)", () => {
  it("a blanket Disallow: / blocks every known AI crawler, reported as possibly accidental", async () => {
    const { result } = await runOn("ai-blanket");
    const f = result.findings.find((x) => x.checkId === "ai-crawlers-blocked");
    expect(f?.severity).toBe("low");
    expect(f?.evidence).toContain(`${AI_AGENTS.length} of ${AI_AGENTS.length} known AI crawlers`);
    expect(f?.evidence).toContain("blocked by the rule for every crawler (may be accidental)");
    expect(f?.evidence).not.toContain("looks intentional");
    // The same file is also robots-block's high finding.
    expect(result.findings.map((x) => x.checkId)).toContain("robots-block");
  });

  it("explicit blocks are reported by name as intentional, and nothing else is blocked", async () => {
    const { result } = await runOn("ai-explicit");
    const f = result.findings.find((x) => x.checkId === "ai-crawlers-blocked");
    expect(f?.evidence).toBe(
      `3 of ${AI_AGENTS.length} known AI crawlers cannot read /; blocked by name (looks intentional): GPTBot (OpenAI), Google-Extended (Google), CCBot (Common Crawl)`,
    );
    expect(result.findings.map((x) => x.checkId)).not.toContain("robots-block");
  });

  it("an llms.txt with an old phone number, old Saturday hours, a 404 and an off-site redirect", async () => {
    const { result, budget, hits } = await runOn("llms-stale");
    const byId = new Map(result.findings.map((f) => [f.checkId, f]));
    expect(byId.get("llms-txt-stale-facts")?.evidence).toBe(
      "phone: llms.txt says (503) 555-0119, structured data says +1 503-555-0142. hours: Sat 08:00-13:00 in llms.txt, 08:00-14:00 in structured data",
    );
    expect(byId.get("llms-txt-broken-links")?.evidence).toBe(
      "2 of 3 links in llms.txt do not work: /catering (404), /order (redirects to http://orders.test/hollyhock)",
    );
    // Same name in both places, and the address agrees.
    expect(byId.has("quotable-facts-disagree")).toBe(false);
    expect(budget.summary().llmsTxtLinks).toEqual({ limit: 10, sampled: 3, found: 3 });
    expect(hits.get("/llms.txt")).toBe(1);
  });
});

describe("AI readability: edge cases", () => {
  it("robots.txt missing: everything is allowed, no finding", async () => {
    const { site, finalUrl } = await contextFor({ "/": send("<title>x</title>", "text/html") });
    expect(site.robotsState).toBe("missing");
    const ctx = { warn, site: async () => site };
    expect(await aiCrawlersBlocked.run(page({ finalUrl }), ctx)).toEqual([]);
  });

  it("robots.txt answering 500: could not check (the check is reported as could-not-run)", async () => {
    const { site, finalUrl } = await contextFor({ "/robots.txt": send("down", "text/plain", 500) });
    const ctx = { warn, site: async () => site };
    await expect(aiCrawlersBlocked.run(page({ finalUrl }), ctx)).rejects.toThrow(
      "did not answer, so AI crawler access could not be checked",
    );
  });

  it("llms.txt served as an HTML page is no llms.txt: no llms finding", async () => {
    const { site, finalUrl } = await contextFor({
      "/llms.txt": send(
        "<!doctype html><title>Home</title><p>Phone: 503 555 0100</p>",
        "text/html",
      ),
    });
    expect(site.llms).toMatchObject({ state: "missing", file: null });
    const ctx = { warn, site: async () => site };
    expect(await llmsTxtStaleFacts.run(page({ finalUrl, jsonLd: [BAKERY_LD] }), ctx)).toEqual([]);
  });

  it("the agent list is fresh today; an entry 181 days old, or with no valid date, fails", () => {
    expect(staleAgents(AI_AGENTS, new Date()).map((a) => a.token)).toEqual([]);
    const now = new Date("2026-11-05T12:00:00Z");
    const entry = (token: string, lastVerified: string): AiAgent => ({
      token,
      name: token,
      owner: "Invented",
      purpose: "training",
      docs: "https://agents.example/docs",
      lastVerified,
    });
    const list = [
      entry("FreshBot", "2026-10-01"),
      entry("EdgeBot", "2026-05-09"),
      entry("OldBot", "2026-05-08"),
      entry("NoDateBot", "soon"),
    ];
    expect(staleAgents(list, now).map((a) => a.token)).toEqual(["OldBot", "NoDateBot"]);
  });

  it("every agent entry has a token, an https docs page and a YYYY-MM-DD date, and tokens are unique", () => {
    for (const a of AI_AGENTS) {
      expect(a.token).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/);
      expect(a.docs).toMatch(/^https:\/\//);
      expect(a.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const tokens = AI_AGENTS.map((a) => a.token.toLowerCase());
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("quotable-facts-disagree: two different names is a finding; case, punctuation and The are not", async () => {
    expect(sameName("The Hollyhock Bakery", "hollyhock bakery")).toBe(true);
    expect(sameName("Hollyhock Bakery & Café", "Hollyhock Bakery and Cafe")).toBe(true);
    expect(sameName("Hollyhock Bakery", "Hollyhock")).toBe(true);
    expect(sameName("Hollyhock Bakery", "Larkspur Tea Room")).toBe(false);
    const site = {
      llms: {
        url: "https://hollyhock.test/llms.txt",
        state: "found" as const,
        file: parseLlmsTxt("# Larkspur Tea Room\n"),
      },
    } as SiteContext;
    const found = await quotableFactsDisagree.run(page({ jsonLd: [BAKERY_LD] }), {
      warn,
      site: async () => site,
    });
    expect(found).toEqual([
      expect.objectContaining({
        severity: "high",
        evidence: 'structured data says "Hollyhock Bakery"; llms.txt is titled "Larkspur Tea Room"',
      }),
    ]);
  });
});
