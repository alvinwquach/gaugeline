import { describe, expect, it } from "vitest";
import { page } from "../../checks/__tests__/helpers.js";
import type { Hop } from "../../fetcher.js";
import { buildSnapshot } from "../../snapshot.js";
import {
  cacheNote,
  duration,
  findName,
  linksTo,
  menuItemNames,
  sameName,
  sameWord,
  says,
  visibleLines,
} from "../text.js";

const hop = (body: string, headers: Record<string, string> = {}): Hop => ({
  url: "https://shop.example/menu",
  status: 200,
  headers: { "content-type": "text/html", ...headers },
  ms: 1,
  body,
});
const snap = (body: string) => buildSnapshot([hop(body)]);

describe("says: phrase matching", () => {
  it("is case-insensitive", () => {
    expect(says("Pre-orders are closed. ORDER AT THE BAR tonight", "order at the bar")).toBe(true);
  });

  it("ignores accents on either side", () => {
    expect(says("Pida en la barra. Agotado esta noche", "pida en la barra")).toBe(true);
    expect(says("P\u00EDdalo en la barra", "pidalo en la barra")).toBe(true);
    expect(says("Men\u00FA de hoy: Caf\u00E9", "cafe")).toBe(true);
  });

  it("ignores spacing and punctuation inside the phrase", () => {
    expect(says("Sorry -   sold   out!", "Sold out")).toBe(true);
    expect(says("Pre-orders are closed", "Pre-orders are closed.")).toBe(true);
  });

  it("matches whole words, not part of one", () => {
    expect(says("The class is sold outside", "sold out")).toBe(false);
  });

  it("does not match words split across two lines of the page", () => {
    expect(says("order at the\nbar", "order at the bar")).toBe(false);
  });

  it("an empty phrase says nothing", () => {
    expect(says("anything", "  ")).toBe(false);
  });
});

describe("visibleLines: what a visitor reads", () => {
  it("leaves out scripts, styles, noscript, hidden elements and aria-hidden", () => {
    const text = visibleLines(
      snap(
        `<body><p>Open tonight</p><script>var x="Sold out"</script><style>.a{}</style>
        <noscript>Sold out noscript</noscript><div hidden>Sold out hidden</div>
        <div aria-hidden="true">Sold out aria</div><div style="display:none">Sold out css</div>
        <span style="visibility: hidden">Sold out vis</span></body>`,
      ),
    );
    expect(text).toBe("Open tonight");
  });

  it("puts each block on its own line and keeps inline text together", () => {
    const text = visibleLines(
      snap(
        `<body><ul><li><span>Tamal</span> <b>de</b> rajas</li><li>Pozole</li></ul><p>a<br>b</p></body>`,
      ),
    );
    expect(text).toBe("Tamal de rajas\nPozole\na\nb");
  });

  it("strips zero-width characters that content source maps add", () => {
    const zw = String.fromCharCode(0x200b);
    expect(visibleLines(snap(`<body><p>Sold${zw} out</p></body>`))).toBe("Sold out");
  });

  it("reads the options of a select, which is where an order form lists items", () => {
    expect(
      visibleLines(
        snap(`<body><select><option>Fried pickles</option><option>Tacos</option></select></body>`),
      ),
    ).toBe("Fried pickles\nTacos");
  });
});

describe("findName: where an item is listed", () => {
  it("finds a name on a line of its own or before a price", () => {
    expect(findName("Smash Burger\n$14", "Smash burger")).toEqual(["Smash Burger"]);
    expect(findName("Smash burger $14", "Smash burger")).toEqual(["Smash burger"]);
    expect(findName("Smash burger 14", "Smash burger")).toEqual(["Smash burger"]);
    expect(findName("Smash burger, with fries", "Smash burger")).toEqual(["Smash burger"]);
  });

  it("matches a plural against a singular and the other way, and reports the page's own spelling", () => {
    expect(findName("Tamal de rajas $6", "Tamales de rajas")).toEqual(["Tamal de rajas"]);
    expect(findName("Smash burgers - $14", "Smash burger")).toEqual(["Smash burgers"]);
    expect(findName("Berry tart", "Berries tart")).toEqual(["Berry tart"]);
  });

  it("matches across accents", () => {
    expect(findName("Jalape\u00F1o poppers $9", "Jalapeno poppers")).toEqual([
      "Jalape\u00F1o poppers",
    ]);
  });

  it("does not find a short name inside a longer item's name", () => {
    expect(findName("Tamal de rajas $6", "Tamal")).toEqual([]);
    expect(findName("Fish tacos with slaw", "Fish tacos")).toEqual([]);
  });

  it("does not find a name in the middle of a sentence", () => {
    expect(findName("We sold the last smash burger an hour ago", "Smash burger")).toEqual([]);
  });

  it("finds a name after a label and a colon, and a numbered line", () => {
    expect(findName("Today: Pozole rojo", "Pozole rojo")).toEqual(["Pozole rojo"]);
    expect(findName("2 Pozole rojo", "Pozole rojo")).toEqual(["Pozole rojo"]);
  });

  it("does not match words split over two lines", () => {
    expect(findName("Smash\nburger", "Smash burger")).toEqual([]);
  });

  it("sameWord and sameName ignore case, accents and plural endings only", () => {
    expect(sameWord("tamales", "tamal")).toBe(true);
    expect(sameWord("tomatoes", "tomato")).toBe(true);
    expect(sameWord("bus", "buses")).toBe(true);
    expect(sameWord("glass", "glas")).toBe(false);
    expect(sameWord("tacos", "tacos")).toBe(true);
    expect(sameWord("pork", "pork2")).toBe(false);
    expect(sameName("Smash burgers", "smash Burger")).toBe(true);
    expect(sameName("Smash burger", "Smash burger deluxe")).toBe(false);
  });
});

describe("linksTo", () => {
  const p = page({
    links: [
      { href: "https://shop.example/order", text: "Order now", sameSite: true },
      { href: "https://shop.example/order/", text: "slash", sameSite: true },
      { href: "https://shop.example/order/checkout?x=1", text: "Checkout", sameSite: true },
      { href: "https://shop.example/order-history", text: "History", sameSite: true },
      { href: "https://other.example/order", text: "Elsewhere", sameSite: false },
      { href: "https://shop.example/menu", text: "Menu", sameSite: true },
    ],
  });

  it("covers the path, its trailing-slash form and anything under it, but not a longer name", () => {
    expect(linksTo(p, "/order").map((l) => l.text)).toEqual(["Order now", "slash", "Checkout"]);
  });

  it("/ covers the home page only", () => {
    expect(
      linksTo(
        page({
          links: [
            { href: "https://shop.example/", text: "Home", sameSite: true },
            { href: "https://shop.example/menu", text: "Menu", sameSite: true },
          ],
        }),
        "/",
      ),
    ).toHaveLength(1);
  });
});

describe("menuItemNames", () => {
  it("finds MenuItem nodes however deep, with a prefixed type, and ignores other types", () => {
    const names = menuItemNames({
      jsonLd: [
        {
          "@type": "Restaurant",
          name: "Not an item",
          hasMenu: {
            "@type": "Menu",
            hasMenuSection: [
              {
                "@type": "MenuSection",
                hasMenuItem: [{ "@type": "MenuItem", name: "Pozole rojo" }],
              },
              { "@type": ["Thing", "schema:MenuItem"], name: "Tacos" },
            ],
          },
        },
        { "@type": "MenuItem", name: " Pozole rojo " },
        { "@type": "Product", name: "Hot sauce" },
      ],
    });
    expect(names).toEqual(["Pozole rojo", "Tacos"]);
  });

  it("stops at a sensible depth rather than looping on a very deep value", () => {
    let deep: unknown = { "@type": "MenuItem", name: "Buried" };
    for (let i = 0; i < 50; i++) deep = { child: deep };
    expect(menuItemNames({ jsonLd: [deep] })).toEqual([]);
  });
});

describe("cacheNote: the Age header (RFC 9111)", () => {
  it("says how old the cached copy is and what Cache-Control allowed", () => {
    const note = cacheNote(hop("", { age: "3140", "cache-control": "public, s-maxage=3600" }));
    expect(note).toContain("served from a cache: Age 3140 (52 minutes old)");
    expect(note).toContain("Cache-Control: public, s-maxage=3600");
  });

  it("is empty with no Age header, or one that is not a number", () => {
    expect(cacheNote(hop(""))).toBe("");
    expect(cacheNote(hop("", { age: "soon" }))).toBe("");
    expect(cacheNote(undefined)).toBe("");
  });

  it("escapes what the site sent", () => {
    expect(cacheNote(hop("", { age: "5", "cache-control": "x\u200By" }))).toContain("x\\u{200B}y");
  });

  it("durations read as a person would say them", () => {
    expect(duration(1)).toBe("1 second");
    expect(duration(40)).toBe("40 seconds");
    expect(duration(3140)).toBe("52 minutes");
    expect(duration(7500)).toBe("2 hours 5 minutes");
    expect(duration(3 * 86400)).toBe("3 days");
  });
});
