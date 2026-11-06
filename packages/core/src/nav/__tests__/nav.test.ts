import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { buildRunSnapshot } from "../../run-snapshot.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { diffNav, inboundLinks, orphans } from "../graph.js";
import { readRegions, type NavEntry } from "../read-regions.js";

const NAV_IDS = ["nav-changed", "nav-orphans", "nav-parity", "nav-footer"];
const page = (html: string, url = "https://bake.example/") =>
  buildSnapshot([
    { url, status: 200, headers: { "content-type": "text/html" }, body: html, ms: 1 } as Hop,
  ]);
const e = (
  region: NavEntry["region"],
  parent: string,
  text: string,
  path: string,
  order: number,
): NavEntry => ({
  region,
  parent,
  text,
  destination: `https://bake.example${path}`,
  order,
});

describe("navigation: unit", () => {
  it("the diff table: added, removed, moved, renamed, reordered", () => {
    const before = [
      e("header", "", "Menu", "/menu", 0),
      e("header", "Menu", "Breads", "/menu/breads", 0),
      e("header", "", "Catering", "/catering", 1),
      e("header", "", "About", "/about", 2),
      e("header", "", "Gift cards", "/gift-cards", 3),
      e("footer", "", "Privacy", "/privacy", 0),
      e("footer", "", "Terms", "/terms", 1),
    ];
    const after = [
      e("header", "", "Menu", "/menu", 0),
      e("header", "Menu", "Breads", "/menu/breads", 0),
      e("header", "Menu", "Catering", "/catering", 1),
      e("header", "", "Our story", "/about", 1),
      e("header", "", "Blog", "/blog", 2),
      e("footer", "", "Terms", "/terms", 0),
      e("footer", "", "Privacy", "/privacy", 1),
    ];
    expect(diffNav(before, after).map((c) => [c.kind, c.text, c.from ?? "", c.to ?? ""])).toEqual([
      ["moved", "Catering", "the top level", "Menu"],
      ["removed", "Gift cards", "", ""],
      ["added", "Blog", "", ""],
      ["renamed", "Our story", "About", ""],
      ["reordered", "Terms", "2", "1"],
      ["reordered", "Privacy", "1", "2"],
    ]);
  });

  it("orphans on a small graph: a page nothing links to, the checked page excepted", () => {
    const pages = [
      {
        url: "https://bake.example/",
        entries: [e("header", "", "A", "/a", 0)],
        mobileBuiltByScript: false,
      },
      {
        url: "https://bake.example/a",
        entries: [e("body", "", "Self", "/a", 0), e("body", "", "B", "/b", 0)],
        mobileBuiltByScript: false,
      },
    ];
    const inbound = inboundLinks(pages);
    expect(
      orphans(
        [
          "https://bake.example/",
          "https://bake.example/a",
          "https://bake.example/b/",
          "https://bake.example/c",
          "https://elsewhere.example/d",
        ],
        inbound,
        "https://bake.example/",
      ),
    ).toEqual(["https://bake.example/c"]);
  });

  it("menus keep their parent; a hover-only submenu is read from the HTML; another site's link is kept", () => {
    const nav = readRegions(
      page(`<header><nav><ul>
        <li><a href="/menu">Menu</a><ul class="hover-only"><li><a href="/catering">Catering</a></li></ul></li>
        <li><span>Services</span><ul><li><a href="/catering">Catering</a></li></ul></li>
        <li><a href="https://instagram.example/rye">Instagram</a></li>
      </ul></nav></header><main><a href="/menu">See the menu</a></main>
      <footer><div><h3>Company</h3><ul><li><a href="/about">About</a></li></ul></div></footer>`),
    );
    expect(nav.entries.map((x) => [x.region, x.parent, x.text, x.destination])).toEqual([
      ["header", "", "Menu", "https://bake.example/menu"],
      ["header", "Menu", "Catering", "https://bake.example/catering"],
      ["header", "Services", "Catering", "https://bake.example/catering"],
      ["header", "", "Instagram", "https://instagram.example/rye"],
      ["body", "", "See the menu", "https://bake.example/menu"],
      ["footer", "Company", "About", "https://bake.example/about"],
    ]);
  });

  it("the same destination under two parents is two entries: removing one is one change", () => {
    const before = [
      e("header", "Menu", "Catering", "/catering", 0),
      e("header", "Services", "Catering", "/catering", 0),
    ];
    const after = [e("header", "Menu", "Catering", "/catering", 0)];
    expect(diffNav(before, after).map((c) => [c.kind, c.parent])).toEqual([
      ["removed", "Services"],
    ]);
  });
});

describe("navigation: integration (the bakery before and after its menu restructure)", () => {
  const run = async (name: string, previous?: ReturnType<typeof buildRunSnapshot>) => {
    const site = await startFixture(name);
    try {
      return await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: NAV_IDS,
        baselineRequested: true,
        ...(previous ? { previous } : {}),
      });
    } finally {
      await site.close();
    }
  };

  it("exactly the removed, moved and renamed links, and the one page left with no inbound link", async () => {
    const before = await run("nav-before");
    // Before: nothing to compare with yet; the other three still run and find nothing.
    expect(before.result.findings).toEqual([]);
    expect(before.result.couldNotCheck.map((c) => [c.id, c.reason])).toEqual([
      ["nav-changed", "no saved menu to compare with yet: this run saves one"],
    ]);
    const after = await run("nav-after", buildRunSnapshot(before.snapshot));
    const changed = after.result.findings.filter((f) => f.checkId === "nav-changed");
    expect(changed.map((f) => [f.severity, f.evidence])).toEqual([
      ["high", "Removed: header › Gift cards (/gift-cards); no page read links to /gift-cards now"],
      ["medium", "Moved: header › Catering (/catering) from the top level to Menu"],
      ["low", 'Renamed: header › "About" to "Our story" (/about)'],
    ]);
    expect(after.result.findings.find((f) => f.checkId === "nav-orphans")?.evidence).toBe(
      "1 sitemap address has no link from the 5 pages read: /gift-cards",
    );
  });

  it("the mobile menu lacks one desktop link; one template's footer differs", async () => {
    const after = await run("nav-after");
    expect(after.result.findings.find((f) => f.checkId === "nav-parity")?.evidence).toBe(
      "The mobile menu has no link to /visit, which the desktop menu has",
    );
    expect(
      after.result.findings.filter((f) => f.checkId === "nav-footer").map((f) => f.evidence),
    ).toEqual(["The footer on /menu/breads differs from 4 other pages: no link to /terms"]);
  });
});

describe("navigation: edge cases", () => {
  it("a menu toggle whose menu isn't in the HTML: parity is could not check", () => {
    const nav = readRegions(
      page(
        '<header><button aria-controls="drawer" aria-expanded="false">Menu</button><nav><a href="/a">A</a></nav></header><div id="drawer"></div>',
      ),
    );
    expect([nav.mobile, nav.mobileBuiltByScript]).toEqual([undefined, true]);
  });

  it("required footer links from the config: one missing is a finding", async () => {
    const { navFooter } = await import("../../checks/nav-footer.js");
    const p = page(
      '<footer><a href="/privacy">Privacy</a><a href="/contact">Get in touch</a></footer>',
    );
    const found = await navFooter.run(p, {
      warn: () => undefined,
      navRules: { requiredFooter: ["privacy", "terms", "contact"] },
    });
    expect(found.map((f) => f.evidence)).toEqual([
      'The footer has no "terms" link, which gaugeline.nav.json marks as required',
    ]);
  });

  it("a link to another site in the menu counts in the diff, and never as an orphan", () => {
    const before = [e("header", "", "Instagram", "/x", 0)].map((x) => ({
      ...x,
      destination: "https://instagram.example/rye",
    }));
    expect(diffNav(before, []).map((c) => c.kind)).toEqual(["removed"]);
    expect(orphans(["https://instagram.example/rye"], new Map(), "https://bake.example/")).toEqual(
      [],
    );
  });
});
