import { describe, expect, it } from "vitest";
import { switchesConfigSchema, type SwitchesConfig } from "../../switches/config.js";
import type { StatePage, StatePages } from "../../switches/pages.js";
import type {
  AvailabilityResult,
  CapacityResult,
  SwitchResult,
  SwitchesRead,
} from "../../switches/types.js";
import { scopePaths } from "../../switches/config.js";
import type { Hop } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { capacityZeroNotSoldOut } from "../capacity-zero-not-sold-out.js";
import { itemUnavailableShown } from "../item-unavailable-shown.js";
import { switchOffStillLinked } from "../switch-off-still-linked.js";
import { switchPageWrong } from "../switch-page-wrong.js";

const ORIGIN = "https://shop.example";

function at(path: string, body: string, headers: Record<string, string> = {}): PageSnapshot {
  const hop: Hop = {
    url: `${ORIGIN}${path}`,
    status: 200,
    headers: { "content-type": "text/html", ...headers },
    ms: 1,
    body,
  };
  return buildSnapshot([hop]);
}

const doc = (body: string, head = "", lang = "en"): string =>
  `<!doctype html><html lang="${lang}"><head><title>t</title>${head}</head><body>${body}</body></html>`;

/** What the run's reader of named pages would answer: a snapshot, or a reason it could not read. */
function statePages(
  pages: Record<
    string,
    PageSnapshot | { kind: "gone" | "refused" | "unreachable"; message: string }
  >,
  asked: string[] = [],
): StatePages {
  return {
    get(url) {
      asked.push(url);
      const path = new URL(url).pathname;
      const got = pages[path];
      if (!got)
        return Promise.resolve({ ok: false, url, kind: "gone", message: `${path} answers 404` });
      return Promise.resolve(
        "kind" in got ? { ok: false, url, ...got } : ({ ok: true, url, page: got } as StatePage),
      );
    },
  };
}

interface Setup {
  config: SwitchesConfig;
  states?: {
    switches?: Record<string, "on" | "off" | string>;
    availability?: Record<string, string[] | string>;
    capacity?: Record<string, number | string>;
  };
}

/** A read built from a config and the states the sources are said to hold. A string that is not a state is a reason. */
function readOf({ config, states = {} }: Setup): SwitchesRead {
  const switches = (config.switches ?? []).map((rule): SwitchResult => {
    const v = states.switches?.[rule.id] ?? "off";
    return v === "on" || v === "off"
      ? { id: rule.id, source: rule.source, rule, state: v }
      : { id: rule.id, source: rule.source, rule, state: "unknown", reason: v };
  });
  const availability = (config.availability ?? []).map((rule): AvailabilityResult => {
    const id = rule.id ?? `${rule.source}`;
    const v = states.availability?.[id] ?? [];
    return typeof v === "string"
      ? { id, source: rule.source, rule, state: "unknown", reason: v }
      : {
          id,
          source: rule.source,
          rule,
          state: "known",
          items: v.map((name) => ({ name, shown: name })),
        };
  });
  const capacity = (config.capacity ?? []).map((rule): CapacityResult => {
    const id = rule.id ?? `${rule.source}`;
    const v = states.capacity?.[id] ?? 0;
    return typeof v === "string"
      ? { id, source: rule.source, rule, state: "unknown", reason: v }
      : { id, source: rule.source, rule, state: "known", remaining: v };
  });
  return { switches, availability, capacity, paths: scopePaths(config) };
}

function context(
  setup: Setup | undefined,
  pages: Parameters<typeof statePages>[0],
  extra: Partial<CheckContext> = {},
) {
  const notes: Array<{ url: string; reason: string }> = [];
  const asked: string[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push({ url, reason }),
    ...(setup
      ? { switches: () => Promise.resolve(readOf(setup)), statePages: statePages(pages, asked) }
      : {}),
    ...extra,
  };
  return { ctx, notes, asked };
}

const parse = (c: unknown): SwitchesConfig => switchesConfigSchema.parse(c);

describe("switch-off-still-linked", () => {
  const config = parse({
    switches: [
      {
        id: "preorders",
        source: "sanity:siteSettings.features.preOrders",
        whenOff: { noLinksTo: ["/order"], pageSays: { "/order": "order at the bar" } },
      },
    ],
  });
  const home = at(
    "/",
    doc(`<header><a href="/menu">Menu</a> <a href="/order">Pre-order</a></header>`),
  );
  const order = at("/order", doc(`<a href="/">Home</a> <a href="/order/checkout">Continue</a>`));
  const menu = at("/menu", doc(`<a href="/order-history">History</a>`));

  it("flags the page whose header still links to the controlled page, naming the switch, source and link", async () => {
    const { ctx, notes } = context({ config }, { "/order": order, "/menu": menu, "/": home });
    const found = await switchOffStillLinked.run(home, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "switch-off-still-linked",
      severity: "high",
      title: switchOffStillLinked.title,
      url: `${ORIGIN}/`,
    });
    expect(found[0]?.evidence).toBe(
      'preorders is off (sanity:siteSettings.features.preOrders), but / still links to /order ("Pre-order").',
    );
    expect(notes).toEqual([]);
  });

  it("does not flag the controlled page for linking to itself, or a path that only starts the same way", async () => {
    const { ctx } = context(
      { config },
      { "/order": order, "/menu": menu, "/": at("/", doc("hi")) },
    );
    const found = await switchOffStillLinked.run(at("/", doc("hi")), ctx);
    expect(found).toEqual([]);
  });

  it("passes while the switch is on", async () => {
    const { ctx, notes } = context(
      { config, states: { switches: { preorders: "on" } } },
      { "/order": order },
    );
    expect(await switchOffStillLinked.run(home, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("an unknown switch is could not check with the reason, never a pass and never a finding", async () => {
    const { ctx, notes } = context(
      { config, states: { switches: { preorders: "SANITY_PROJECT_ID is not set" } } },
      {},
    );
    expect(await switchOffStillLinked.run(home, ctx)).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toContain('The switch "preorders" is not known');
    expect(notes[0]?.reason).toContain("SANITY_PROJECT_ID is not set");
  });

  it("also reads the other pages the run has, and the pages the file names, once each", async () => {
    const qr = at("/qr", doc(`<a href="/order">Order from your phone</a>`));
    const { ctx, asked } = context(
      { config },
      { "/order": order, "/qr": qr },
      { pages: () => Promise.resolve([home, qr]) },
    );
    const found = await switchOffStillLinked.run(home, ctx);
    expect(found.map((f) => f.url).sort()).toEqual([`${ORIGIN}/`, `${ORIGIN}/qr`]);
    expect(asked).toEqual([`${ORIGIN}/order`]);
  });

  it("a page that cannot be read is could not check; one that answers 404 has no links and is silent", async () => {
    const two = parse({
      switches: [
        {
          id: "preorders",
          source: "db:flag",
          whenOff: { noLinksTo: ["/order"], pageSays: { "/order": "x", "/qr": "y", "/gone": "z" } },
        },
      ],
    });
    const { ctx, notes } = context(
      { config: two },
      {
        "/order": order,
        "/qr": {
          kind: "refused",
          message: "/qr refused automated readers (403), so it was not read",
        },
      },
    );
    await switchOffStillLinked.run(at("/", doc("hi")), ctx);
    expect(notes.map((n) => n.reason)).toEqual([
      "/qr refused automated readers (403), so it was not read",
    ]);
  });

  it("puts the Age header of a cached page in the evidence", async () => {
    const cached = at("/", doc(`<a href="/order">Pre-order</a>`), {
      age: "3140",
      "cache-control": "public, s-maxage=3600",
    });
    const { ctx } = context({ config }, { "/order": order });
    const found = await switchOffStillLinked.run(cached, ctx);
    expect(found[0]?.evidence).toContain("served from a cache: Age 3140 (52 minutes old)");
  });

  it("said by id with no file, it could not check", async () => {
    const { ctx, notes } = context(undefined, {});
    expect(await switchOffStillLinked.run(home, ctx)).toEqual([]);
    expect(notes[0]?.reason).toContain("gaugeline.switches.json is not set up");
  });
});

describe("switch-page-wrong", () => {
  const config = parse({
    switches: [
      {
        id: "preorders",
        source: "sanity:siteSettings.features.preOrders",
        whenOff: { pageSays: { "/order": "order at the bar" } },
        whenOn: { pageSays: { "/order": "pre-orders are open" } },
      },
    ],
  });
  const home = at("/", doc("home"));

  it("flags a controlled page that does not say what it should for the state", async () => {
    const order = at("/order", doc("<p>Pre-orders are open. Place yours below.</p>"));
    const { ctx } = context({ config }, { "/order": order });
    const found = await switchPageWrong.run(home, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "switch-page-wrong",
      severity: "medium",
      url: `${ORIGIN}/order`,
    });
    expect(found[0]?.evidence).toContain(
      'preorders is off (sanity:siteSettings.features.preOrders), and /order does not say "order at the bar".',
    );
  });

  it("passes when the page says it, whatever the case or accents", async () => {
    const order = at(
      "/order",
      doc("<h1>PRE-ORDERS ARE CLOSED</h1><p>Order at the BAR tonight.</p>"),
    );
    const { ctx } = context({ config }, { "/order": order });
    expect(await switchPageWrong.run(home, ctx)).toEqual([]);
  });

  it("does not count text a visitor cannot see", async () => {
    const order = at(
      "/order",
      doc(`<div hidden>order at the bar</div><script>"order at the bar"</script>`),
    );
    const { ctx } = context({ config }, { "/order": order });
    expect(await switchPageWrong.run(home, ctx)).toHaveLength(1);
  });

  it("uses the on-state phrase while the switch is on", async () => {
    const order = at("/order", doc("<p>Order at the bar</p>"));
    const { ctx } = context(
      { config, states: { switches: { preorders: "on" } } },
      { "/order": order },
    );
    const found = await switchPageWrong.run(home, ctx);
    expect(found[0]?.evidence).toContain("preorders is on");
    expect(found[0]?.evidence).toContain('"pre-orders are open"');
  });

  it("an unknown switch, and a page that cannot be read or answers 404, are could not check", async () => {
    const a = context(
      { config, states: { switches: { preorders: "Sanity refused the key" } } },
      {},
    );
    expect(await switchPageWrong.run(home, a.ctx)).toEqual([]);
    expect(a.notes[0]?.reason).toContain("Sanity refused the key");
    const b = context(
      { config },
      { "/order": { kind: "unreachable", message: "/order could not be reached" } },
    );
    expect(await switchPageWrong.run(home, b.ctx)).toEqual([]);
    expect(b.notes.map((n) => n.reason)).toEqual(["/order could not be reached"]);
    const c = context({ config }, {});
    expect(await switchPageWrong.run(home, c.ctx)).toEqual([]);
    expect(c.notes.map((n) => n.reason)).toEqual(["/order answers 404"]);
  });

  describe("bilingual sites", () => {
    const bilingual = parse({
      switches: [
        {
          id: "preorders",
          source: "db:flag",
          whenOff: { pageSays: { "/order": { en: "order at the bar", es: "pida en la barra" } } },
        },
      ],
    });
    const rules = { prefixes: { en: "/", es: "/es/" }, default: "en" };

    it("reads each language's version of the page and expects that language's phrase", async () => {
      const en = at("/order", doc("<p>Order at the bar</p>"));
      const es = at("/es/order", doc("<p>Order at the bar</p>", "", "es"));
      const { ctx, asked } = context(
        { config: bilingual },
        { "/order": en, "/es/order": es },
        { languageRules: rules },
      );
      const found = await switchPageWrong.run(at("/", doc("x")), ctx);
      expect(asked).toEqual([`${ORIGIN}/order`, `${ORIGIN}/es/order`]);
      expect(found).toHaveLength(1);
      expect(found[0]?.url).toBe(`${ORIGIN}/es/order`);
      expect(found[0]?.evidence).toContain('"pida en la barra"');
    });

    it("without the site's language scheme, the page's own lang picks the phrase", async () => {
      const es = at("/order", doc("<p>Pida en la barra esta noche</p>", "", "es-MX"));
      const { ctx } = context({ config: bilingual }, { "/order": es });
      expect(await switchPageWrong.run(at("/", doc("x")), ctx)).toEqual([]);
      const en = at("/order", doc("<p>Pida en la barra</p>", "", "en"));
      const wrong = context({ config: bilingual }, { "/order": en });
      const found = await switchPageWrong.run(at("/", doc("x")), wrong.ctx);
      expect(found[0]?.evidence).toContain('"order at the bar"');
    });

    it("a page in a language the phrases do not cover may say any of them", async () => {
      const fr = at("/order", doc("<p>Pida en la barra</p>", "", "fr"));
      const { ctx } = context({ config: bilingual }, { "/order": fr });
      expect(await switchPageWrong.run(at("/", doc("x")), ctx)).toEqual([]);
    });
  });
});

describe("item-unavailable-shown", () => {
  const config = parse({
    availability: [
      {
        id: "eighty-six",
        source: "db:eightySixed",
        items: "name",
        mustNotAppearOn: ["/menu", "/tonight"],
        alsoIn: "menu-jsonld",
      },
    ],
  });
  const ld = (names: string[]): string =>
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Menu",
      hasMenuSection: [
        {
          "@type": "MenuSection",
          hasMenuItem: names.map((name) => ({ "@type": "MenuItem", name })),
        },
      ],
    })}</script>`;
  const home = at("/", doc("home"));

  it("flags an item still listed on a page, giving the page's spelling and the database's when they differ", async () => {
    const menu = at(
      "/menu",
      doc("<ul><li><span>Smash Burger</span> <span>$14</span></li><li>Fish tacos $13</li></ul>"),
    );
    const { ctx } = context(
      { config, states: { availability: { "eighty-six": ["Smash burgers"] } } },
      { "/menu": menu, "/tonight": at("/tonight", doc("<li>Fish tacos</li>")) },
    );
    const found = await itemUnavailableShown.run(home, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "item-unavailable-shown",
      severity: "high",
      url: `${ORIGIN}/menu`,
    });
    expect(found[0]?.evidence).toBe(
      'eighty-six (db:eightySixed) marks an item unavailable, but /menu still shows "Smash Burger" (the database has "Smash burgers").',
    );
  });

  it("an identical spelling is reported once, without the parenthesis", async () => {
    const menu = at("/menu", doc("<li>Fried pickles $8</li>"));
    const { ctx } = context(
      { config, states: { availability: { "eighty-six": ["Fried pickles"] } } },
      { "/menu": menu, "/tonight": at("/tonight", doc("x")) },
    );
    const found = await itemUnavailableShown.run(home, ctx);
    expect(found[0]?.evidence).toContain('still shows "Fried pickles".');
  });

  it("finds an item in the Menu structured data of a listed page, and of the page checked", async () => {
    const menu = at("/menu", doc("<p>Nothing here</p>", ld(["Pozole rojo", "Tacos"])));
    const checked = at("/", doc("home", ld(["Pozole rojo"])));
    const { ctx } = context(
      { config, states: { availability: { "eighty-six": ["Pozole Rojo"] } } },
      { "/menu": menu, "/tonight": at("/tonight", doc("x")) },
    );
    const found = await itemUnavailableShown.run(checked, ctx);
    expect(found.map((f) => [f.url, f.evidence])).toEqual([
      [
        `${ORIGIN}/`,
        'eighty-six (db:eightySixed) marks an item unavailable, but the Menu structured data of / still has "Pozole rojo" (the database has "Pozole Rojo").',
      ],
      [
        `${ORIGIN}/menu`,
        'eighty-six (db:eightySixed) marks an item unavailable, but the Menu structured data of /menu still has "Pozole rojo" (the database has "Pozole Rojo").',
      ],
    ]);
  });

  it("without alsoIn the structured data is not read", async () => {
    const plain = parse({
      availability: [{ source: "db:eightySixed", items: "name", mustNotAppearOn: ["/menu"] }],
    });
    const menu = at("/menu", doc("<p>Nothing here</p>", ld(["Pozole rojo"])));
    const { ctx } = context(
      { config: plain, states: { availability: { "db:eightySixed": ["Pozole rojo"] } } },
      { "/menu": menu },
    );
    expect(await itemUnavailableShown.run(home, ctx)).toEqual([]);
  });

  it("does not take a short name for a longer item", async () => {
    const menu = at("/menu", doc("<li>Tamal de rajas $6</li>"));
    const { ctx } = context(
      { config, states: { availability: { "eighty-six": ["Tamal"] } } },
      { "/menu": menu, "/tonight": at("/tonight", doc("x")) },
    );
    expect(await itemUnavailableShown.run(home, ctx)).toEqual([]);
  });

  it("an empty list passes; an unknown one is could not check with the reason", async () => {
    const empty = context({ config, states: { availability: { "eighty-six": [] } } }, {});
    expect(await itemUnavailableShown.run(home, empty.ctx)).toEqual([]);
    expect(empty.notes).toEqual([]);
    const unknown = context(
      { config, states: { availability: { "eighty-six": "The database was not read." } } },
      {},
    );
    expect(await itemUnavailableShown.run(home, unknown.ctx)).toEqual([]);
    expect(unknown.notes[0]?.reason).toContain('The list "eighty-six" is not known');
  });

  it("a listed page that answers 404 shows nothing and is silent; one that cannot be read is could not check", async () => {
    const { ctx, notes } = context(
      { config, states: { availability: { "eighty-six": ["Smash burgers"] } } },
      {
        "/menu": {
          kind: "refused",
          message: "/menu showed a bot challenge page, so it was not read",
        },
      },
    );
    expect(await itemUnavailableShown.run(home, ctx)).toEqual([]);
    expect(notes.map((n) => n.reason)).toEqual([
      "/menu showed a bot challenge page, so it was not read",
    ]);
  });

  it("puts the Age of a cached menu in the evidence, and escapes the page's own text", async () => {
    const menu = at("/menu", doc("<li>Smash\u202Eburger</li>"), { age: "90" });
    const { ctx } = context(
      { config, states: { availability: { "eighty-six": ["Smash\u202Eburger"] } } },
      { "/menu": menu, "/tonight": at("/tonight", doc("x")) },
    );
    const found = await itemUnavailableShown.run(home, ctx);
    expect(found[0]?.evidence).toContain("Age 90 (2 minutes old)");
    expect(found[0]?.evidence).toContain("\\u{202E}");
    expect(found[0]?.evidence).not.toContain("\u202E");
  });

  it("lists many items briefly", async () => {
    const names = ["A one", "B two", "C three", "D four", "E five", "F six"];
    const menu = at("/menu", doc(`<ul>${names.map((n) => `<li>${n} $5</li>`).join("")}</ul>`));
    const { ctx } = context(
      { config, states: { availability: { "eighty-six": names } } },
      { "/menu": menu, "/tonight": at("/tonight", doc("x")) },
    );
    const found = await itemUnavailableShown.run(home, ctx);
    expect(found[0]?.evidence).toContain("marks 6 items unavailable");
    expect(found[0]?.evidence).toContain("and 2 more");
  });
});

describe("capacity-zero-not-sold-out", () => {
  const config = parse({
    capacity: [
      {
        id: "tonight",
        source: "db:tonightRemaining",
        whenZero: { pageSays: { "/order": "sold out" } },
      },
    ],
  });
  const home = at("/", doc("home"));
  const open = at(
    "/order",
    doc(`<h1>Order</h1><form action="/api/order" method="post"><button>Order</button></form>`),
  );

  it("flags an order page that still looks open when nothing is left, and mentions the form", async () => {
    const { ctx } = context({ config, states: { capacity: { tonight: 0 } } }, { "/order": open });
    const found = await capacityZeroNotSoldOut.run(home, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "capacity-zero-not-sold-out",
      severity: "high",
      url: `${ORIGIN}/order`,
    });
    expect(found[0]?.evidence).toBe(
      'tonight (db:tonightRemaining) has 0 left, and /order does not say "sold out"; it still has an order form.',
    );
  });

  it("negative remaining (oversold) counts as zero", async () => {
    const { ctx } = context({ config, states: { capacity: { tonight: -3 } } }, { "/order": open });
    expect(await capacityZeroNotSoldOut.run(home, ctx)).toHaveLength(1);
  });

  it("passes while some are left, even if the page says nothing", async () => {
    const { ctx, asked } = context(
      { config, states: { capacity: { tonight: 12 } } },
      { "/order": open },
    );
    expect(await capacityZeroNotSoldOut.run(home, ctx)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("passes when the page says sold out", async () => {
    const page = at("/order", doc("<h1>SOLD OUT for tonight</h1>"));
    const { ctx } = context({ config, states: { capacity: { tonight: 0 } } }, { "/order": page });
    expect(await capacityZeroNotSoldOut.run(home, ctx)).toEqual([]);
  });

  it("an unknown number is could not check, never a pass", async () => {
    const { ctx, notes } = context(
      { config, states: { capacity: { tonight: "The query returned no rows" } } },
      {},
    );
    expect(await capacityZeroNotSoldOut.run(home, ctx)).toEqual([]);
    expect(notes[0]?.reason).toContain('The capacity "tonight" is not known');
  });

  it("puts the cache's Age in the evidence", async () => {
    const cached = at("/order", doc("<p>Order now</p>"), {
      age: "7300",
      "cache-control": "s-maxage=86400",
    });
    const { ctx } = context({ config, states: { capacity: { tonight: 0 } } }, { "/order": cached });
    const found = await capacityZeroNotSoldOut.run(home, ctx);
    expect(found[0]?.evidence).toContain(
      "Age 7300 (2 hours 2 minutes old), Cache-Control: s-maxage=86400",
    );
  });

  it("said by id with no file, it could not check", async () => {
    const { ctx, notes } = context(undefined, {});
    expect(await capacityZeroNotSoldOut.run(home, ctx)).toEqual([]);
    expect(notes).toHaveLength(1);
  });
});

describe("the four switch checks: reference text", () => {
  it("each has the text the checks reference prints", () => {
    for (const c of [
      switchOffStillLinked,
      switchPageWrong,
      itemUnavailableShown,
      capacityZeroNotSoldOut,
    ])
      for (const field of ["what", "why", "fix", "tech"] as const)
        expect(c[field].length, `${c.id} ${field}`).toBeGreaterThan(40);
  });
});
