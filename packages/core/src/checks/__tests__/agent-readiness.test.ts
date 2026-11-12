import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { AI_AGENTS } from "../../ai-agents.js";
import { aiConfigSchema, intentMismatches, wantsAllowed } from "../../ai-intent.js";
import { createFetcher } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import { parseLlmsTxt } from "../../llms.js";
import { parseRobots } from "../../robots.js";
import { checkSite } from "../../site.js";
import { buildSiteContext, type SiteContext } from "../../site-context.js";
import { judgeWellKnown } from "../../well-known.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { aiCrawlersBlocked } from "../ai-crawlers-blocked.js";
import { aiCrawlersIntent } from "../ai-crawlers-intent.js";
import { llmsTxtMalformed } from "../llms-txt-malformed.js";
import { quotableFactsInDataOnly } from "../quotable-facts-in-data-only.js";
import { wellKnownInvalid } from "../well-known-invalid.js";
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

async function contextFor(routes: Parameters<typeof startServer>[0]) {
  const server = await startServer(routes);
  servers.push(server);
  const finalUrl = `${server.origin}/`;
  const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
  const site = await buildSiteContext({
    page: page({ finalUrl }),
    fetcher,
    budget: createBudget(),
  });
  return { site, finalUrl, fetcher };
}

const byToken = (t: string) => {
  const a = AI_AGENTS.find((x) => x.token === t);
  if (!a) throw new Error(`${t} is not in the agent list`);
  return a;
};

describe("intent: unit", () => {
  it.each([
    ["allow", "training", true],
    ["block", "search", false],
    ["training-block", "training", false],
    ["training-block", "search", true],
    ["training-block", "user", true],
    ["search-only", "search", true],
    ["search-only", "training", false],
    ["search-only", "user", false],
  ] as const)("%s wants %s allowed: %s", (intent, purpose, want) => {
    expect(wantsAllowed(intent, purpose)).toBe(want);
  });

  it("the settings file takes one of the four intents and nothing else", () => {
    expect(aiConfigSchema.safeParse({ aiCrawlers: "search-only" }).success).toBe(true);
    expect(aiConfigSchema.safeParse({}).success).toBe(true);
    expect(aiConfigSchema.safeParse({ aiCrawlers: "maybe" }).success).toBe(false);
    expect(aiConfigSchema.safeParse({ aiCrawlers: "allow", extra: 1 }).success).toBe(false);
  });

  it("a named group beats the wildcard; Allow beats Disallow of equal length; the longest rule wins", () => {
    const robots = parseRobots(
      [
        "User-agent: GPTBot",
        "Disallow: /",
        "",
        "User-agent: ClaudeBot",
        "Disallow: /blog",
        "Allow: /blog",
        "",
        "User-agent: *",
        "Disallow: /",
        "Allow: /about",
      ].join("\n"),
    );
    const agents = [byToken("GPTBot"), byToken("ClaudeBot"), byToken("PerplexityBot")];
    expect(intentMismatches(robots, "allow", "/", agents).map((m) => m.agent.token)).toEqual([
      "GPTBot",
      "PerplexityBot",
    ]);
    // /about: the wildcard Allow is longer than its Disallow, GPTBot's own group still blocks it.
    expect(intentMismatches(robots, "allow", "/about", agents).map((m) => m.agent.token)).toEqual([
      "GPTBot",
    ]);
    expect(intentMismatches(robots, "allow", "/blog", agents)).toEqual([
      expect.objectContaining({ agent: byToken("GPTBot"), allowed: false }),
      expect.objectContaining({ agent: byToken("PerplexityBot"), allowed: false }),
    ]);
  });

  it("no robots.txt: everything is allowed, so only a block intent disagrees", () => {
    expect(intentMismatches(null, "allow", "/")).toEqual([]);
    expect(intentMismatches(null, "block", "/")).toHaveLength(AI_AGENTS.length);
  });

  it("a hostile robots.txt (megabytes, BOM, CRLF, lone surrogate) parses and matches quickly", () => {
    const rules = Array.from({ length: 60_000 }, (_, i) => `Disallow: /p${i}/*/*/x$`).join("\r\n");
    const text = `\uFEFFUser-agent: GPTBot\r\n${rules}\r\nDisallow: /\ud800caf\r\n`;
    const started = Date.now();
    const robots = parseRobots(text);
    // Only a deep path is disallowed, so "/" is allowed and a block intent disagrees.
    expect(intentMismatches(robots, "block", "/", [byToken("GPTBot")])).toEqual([
      expect.objectContaining({ allowed: true }),
    ]);
    expect(intentMismatches(robots, "block", "/p7/a/b/x", [byToken("GPTBot")])).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("llms.txt parser caps", () => {
  it("reads at most 50000 lines and 2000 characters of a line", () => {
    const long = `- [Page](https://larkspur.test/${"a".repeat(5000)})`;
    const file = parseLlmsTxt(
      `# T\n## S\n${long}\n${"- [x](https://larkspur.test/x)\n".repeat(60_000)}`,
    );
    expect(file.sections[0]?.links.length).toBeLessThanOrEqual(50_000);
  });
});

describe("well-known judgement: unit", () => {
  const hop = (status: number, body: string, type = "application/json") => ({
    url: "https://larkspur.test/.well-known/agent.json",
    status,
    headers: { "content-type": type },
    body,
    ms: 1,
  });
  it.each([
    [hop(200, '{"name":"x"}'), "valid"],
    [hop(200, "\uFEFF{}"), "valid"],
    [hop(200, "{ not json"), "invalid"],
    [hop(200, "[1,2]"), "invalid"],
    [hop(200, "null"), "invalid"],
    [hop(404, "nope"), "absent"],
    [hop(500, "boom"), "absent"],
    [hop(200, "<!doctype html><p>Home</p>", "text/html"), "absent"],
    [hop(200, "<html><body>x</body></html>", "text/plain"), "absent"],
    [{ ...hop(200, "{"), truncated: true }, "unread"],
    [undefined, "absent"],
  ])("%#", (h, state) => {
    expect(judgeWellKnown(h).state).toBe(state);
  });
});

describe("ai-crawlers-intent: integration against a local server", () => {
  const ROBOTS_BLANKET = "User-agent: *\nDisallow: /\n";

  it("with no stated intent the check says nothing and ai-crawlers-blocked keeps reporting", async () => {
    const { site, finalUrl } = await contextFor({
      "/robots.txt": send(ROBOTS_BLANKET, "text/plain"),
    });
    const ctx = { warn, site: async () => site };
    expect(await aiCrawlersIntent.run(page({ finalUrl }), ctx)).toEqual([]);
    expect(await aiCrawlersBlocked.run(page({ finalUrl }), ctx)).toHaveLength(1);
  });

  it("search-only against a blanket block: names the search crawlers that are shut out", async () => {
    const { site, finalUrl } = await contextFor({
      "/robots.txt": send(ROBOTS_BLANKET, "text/plain"),
    });
    const ctx = { warn, site: async () => site, ai: { aiCrawlers: "search-only" as const } };
    const found = await aiCrawlersIntent.run(page({ finalUrl }), ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toBe(
      "gaugeline.ai.json says to allow only crawlers that build a search index; for /, blocked but should be allowed: OAI-SearchBot (OpenAI), Claude-SearchBot (Anthropic), PerplexityBot (Perplexity), Amazonbot (Amazon) (4 by the rule for every crawler)",
    );
    // ai-crawlers-blocked hands over to this check once an intent is stated.
    expect(await aiCrawlersBlocked.run(page({ finalUrl }), ctx)).toEqual([]);
  });

  it("allow with a named GPTBot block: the block is named, not blanket", async () => {
    const { site, finalUrl } = await contextFor({
      "/robots.txt": send("User-agent: GPTBot\nDisallow: /\n", "text/plain"),
    });
    const found = await aiCrawlersIntent.run(page({ finalUrl }), {
      warn,
      site: async () => site,
      ai: { aiCrawlers: "allow" },
    });
    expect(found[0]?.evidence).toBe(
      "gaugeline.ai.json says to allow every AI crawler; for /, blocked but should be allowed: GPTBot (OpenAI)",
    );
  });

  it("training-block and rules that match the intent: no finding", async () => {
    const { site, finalUrl } = await contextFor({
      "/robots.txt": send(
        [
          "User-agent: GPTBot",
          "User-agent: ClaudeBot",
          "User-agent: Google-Extended",
          "User-agent: Applebot-Extended",
          "User-agent: CCBot",
          "User-agent: meta-externalagent",
          "Disallow: /",
        ].join("\n"),
        "text/plain",
      ),
    });
    const found = await aiCrawlersIntent.run(page({ finalUrl }), {
      warn,
      site: async () => site,
      ai: { aiCrawlers: "training-block" },
    });
    expect(found).toEqual([]);
  });

  it("no robots.txt (404) with intent block: says nothing stops them", async () => {
    const { site, finalUrl } = await contextFor({});
    const found = await aiCrawlersIntent.run(page({ finalUrl }), {
      warn,
      site: async () => site,
      ai: { aiCrawlers: "block" },
    });
    expect(found[0]?.evidence).toContain("(there is no robots.txt, so nothing stops them)");
  });

  it("robots.txt answering 500 is could-not-check, never allowed", async () => {
    const { site, finalUrl } = await contextFor({ "/robots.txt": send("down", "text/plain", 500) });
    await expect(
      aiCrawlersIntent.run(page({ finalUrl }), {
        warn,
        site: async () => site,
        ai: { aiCrawlers: "allow" },
      }),
    ).rejects.toThrow("could not be compared with gaugeline.ai.json");
  });
});

describe("llms-txt-malformed", () => {
  const run = async (routes: Parameters<typeof startServer>[0]) => {
    const { site, finalUrl } = await contextFor(routes);
    const notes: string[] = [];
    const found = await llmsTxtMalformed.run(page({ finalUrl }), {
      warn,
      site: async () => site,
      couldNotCheck: (_u: string, why: string) => notes.push(why),
    });
    return { found, notes, site };
  };

  it("a title, a summary and no links: reported", async () => {
    const { found } = await run({
      "/llms.txt": send("# Larkspur Family Law\n\n> Family law.\n", "text/plain"),
    });
    expect(found[0]?.evidence).toMatch(/llms\.txt: no ## sections$/);
  });

  it("no title, sections without links, and an empty file", async () => {
    expect(
      (await run({ "/llms.txt": send("## Pages\nsome text\n", "text/plain") })).found[0]?.evidence,
    ).toMatch(/no # title line; no section has a link list/);
    expect((await run({ "/llms.txt": send("  \n", "text/plain") })).found[0]?.evidence).toMatch(
      /the file is empty/,
    );
  });

  it("a well-formed file passes, with a BOM and CRLF", async () => {
    const body =
      "\uFEFF# Larkspur\r\n\r\n> Law.\r\n\r\n## Pages\r\n- [Contact](https://larkspur.test/contact): call us\r\n";
    expect((await run({ "/llms.txt": send(body, "text/plain") })).found).toEqual([]);
  });

  it("an HTML 200 soft 404 is no llms.txt at all: missing, no finding", async () => {
    const { found, site } = await run({
      "/llms.txt": send("<!doctype html><title>Not found</title>", "text/html"),
    });
    expect(site.llms.state).toBe("missing");
    expect(found).toEqual([]);
  });

  it("an oversized file is reported as too long", async () => {
    const links = "- [Page](https://larkspur.test/p): note\n".repeat(6_000);
    const { found } = await run({ "/llms.txt": send(`# T\n## S\n${links}`, "text/plain") });
    expect(found[0]?.evidence).toMatch(/characters is too long for a short guide$/);
  });

  it("a 5xx llms.txt is unknown, not malformed", async () => {
    expect((await run({ "/llms.txt": send("x", "text/plain", 503) })).found).toEqual([]);
  });

  it("a body cut at the fetcher's cap is unread: could not check", async () => {
    const site = {
      llms: {
        url: "https://larkspur.test/llms.txt",
        state: "found" as const,
        file: parseLlmsTxt("# Cut"),
        truncated: true,
      },
    } as SiteContext;
    const notes: string[] = [];
    const found = await llmsTxtMalformed.run(page(), {
      warn,
      site: async () => site,
      couldNotCheck: (_u: string, why: string) => notes.push(why),
    });
    expect(found).toEqual([]);
    expect(notes).toHaveLength(1);
  });
});

describe("well-known-invalid: integration", () => {
  it("reports a served file that does not parse; absent, HTML and valid files are quiet", async () => {
    const { finalUrl, fetcher } = await contextFor({});
    const server = await startServer({
      "/.well-known/agent.json": send('{ "name": ', "application/json"),
      "/.well-known/agent-card.json": send('{"name":"Larkspur"}', "application/json"),
      "/.well-known/ai-plugin.json": send("<!doctype html><p>home</p>", "text/html"),
    });
    servers.push(server);
    void finalUrl;
    const found = await wellKnownInvalid.run(page({ finalUrl: `${server.origin}/` }), {
      warn,
      fetcher,
    });
    expect(found.map((f) => f.evidence)).toEqual([
      ".well-known/agent.json (A2A agent card (earlier path)) is not valid JSON",
    ]);
    // One request per documented path, never a path that is not documented.
    const paths = server.log.map((r) => r.path).sort();
    expect(paths).toEqual([
      "/.well-known/agent-card.json",
      "/.well-known/agent.json",
      "/.well-known/ai-plugin.json",
      "/.well-known/oauth-protected-resource",
    ]);
    expect(server.log.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("quotable-facts-in-data-only", () => {
  const ld = {
    "@type": "LegalService",
    name: "Larkspur Family Law",
    telephone: "+1 503-555-0177",
    address: { streetAddress: "88 Foxglove Avenue", postalCode: "97999" },
  };
  const withBody = (body: string, jsonLd: unknown[] = [ld]) =>
    page({
      jsonLd,
      hops: [
        {
          url: "https://larkspur.test/",
          status: 200,
          headers: {},
          body: `<html><body>${body}</body></html>`,
          ms: 1,
        },
      ],
    });

  it("phone and street only in markup: both reported", async () => {
    const found = await quotableFactsInDataOnly.run(
      withBody("<p>Call us</p><script>var p='503-555-0177'</script>"),
      { warn },
    );
    expect(found[0]?.evidence).toBe(
      "phone and street address in structured data, not found as text on 1 page read",
    );
  });

  it("the facts written as text, in any format, pass", async () => {
    const body = "<footer>Phone (503) 555-0177<br>88 Foxglove   Avenue, Fernvale</footer>";
    expect(await quotableFactsInDataOnly.run(withBody(body), { warn })).toEqual([]);
  });

  it("another page sampled may carry the text", async () => {
    const home = withBody("<p>Welcome</p>");
    const contact = withBody("<p>503.555.0177 at 88 Foxglove Avenue</p>");
    expect(
      await quotableFactsInDataOnly.run(home, { warn, pages: async () => [home, contact] }),
    ).toEqual([]);
  });

  it("no business structured data: nothing to compare", async () => {
    expect(await quotableFactsInDataOnly.run(withBody("<p>x</p>", []), { warn })).toEqual([]);
  });
});

describe("agent readiness: end to end on the ai-agents fixture", () => {
  it("finds the blanket block against the stated intent, and the small problems", async () => {
    const site = await startFixture("ai-agents");
    try {
      const fetcher = createFetcher({ hosts: site.hosts, allowPrivate: true, timeoutMs: 5000 });
      const { result } = await checkSite({
        address: site.origin,
        fetcher,
        ai: { aiCrawlers: "search-only" },
      });
      const byId = new Map(result.findings.map((f) => [f.checkId, f]));
      expect(byId.get("ai-crawlers-intent")?.evidence).toContain("blocked but should be allowed");
      expect(byId.has("ai-crawlers-blocked")).toBe(false);
      expect(byId.get("llms-txt-malformed")?.evidence).toMatch(/no ## sections$/);
      expect(byId.get("well-known-invalid")?.evidence).toContain(".well-known/agent.json");
      expect(byId.get("quotable-facts-in-data-only")?.evidence).toMatch(
        /^phone and street address/,
      );
    } finally {
      await site.close();
    }
  });
});
