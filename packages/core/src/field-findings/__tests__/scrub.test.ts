/**
 * The scrub (AG-15): plain patterns, no model. It names the kind of leak and the line and never the value, so a
 * failing draft cannot become the way a client's name or address reaches a log.
 */
import { describe, expect, it } from "vitest";
import { DenyListError, compileDenyList, scanForLeaks, LEAK_KINDS } from "../scrub.js";

// The repository keeps no address (community:check): the invented ones are put together at run time.
const AT = "@";

const kinds = (text: string, deny?: string) =>
  scanForLeaks(text, deny === undefined ? undefined : compileDenyList(deny)).map((l) => l.kind);

describe("what counts as a leak (failing text)", () => {
  it.each([
    ["a web address", "See https://shop.northgate.example/menu for it", "url"],
    ["an address with no scheme", "Fixed on www.tidewater.example last week", "url"],
    ["a mail link", `Write to mailto:owner${AT}bar.example`, "url"],
    ["an email address", `Ask chef.owner${AT}kitchen.example about it`, "email"],
    ["a bare domain", "The old host was juniper-kitchen.co.uk before", "domain"],
    ["a domain in capitals", "It is on NORTHGATE.EXAMPLE now", "domain"],
    ["a private host name", "db.internal answers slowly", "domain"],
    ["an IPv4 address", "The staging box is 203.0.113.17", "ip"],
    ["an international phone number", "Call +44 20 7946 0958 first", "phone"],
    ["a phone number with brackets", "Call (555) 010-4477 first", "phone"],
    ["a short local number", "Ring 555-0142 to book", "phone"],
    ["a dotted phone number", "Ring 555.010.4477 to book", "phone"],
  ])("%s", (_, text, kind) => {
    expect(kinds(text)).toEqual([kind]);
  });

  it("a domain split by a hidden character or written full-width is still a domain", () => {
    expect(kinds("It is on exam\u200Bple-bar.com now")).toEqual(["domain"]);
    expect(kinds("It is on northgate\uFF0Eexample now")).toEqual(["domain"]);
  });

  it("a web address is one leak, not also a domain", () => {
    expect(kinds("https://shop.northgate.example/menu")).toEqual(["url"]);
    expect(kinds(`chef${AT}kitchen.example`)).toEqual(["email"]);
  });
});

describe("what is not a leak (passing text)", () => {
  it.each([
    "The footer link points at /menu.pdf, which is not served.",
    'Fixture: <a href="/menu">Menu</a> and <meta name="robots" content="noindex">',
    "Check robots.txt, sitemap.xml and llms.txt, then index.html and styles.css.",
    "Next.js and Node.js builds. Version 1.2.3 and 22.11.0 are fine.",
    "e.g. a label, i.e. a name a screen reader can read; 3.5 seconds, 40 percent.",
    "Dates like 2026-11-13 and 12:30, sizes like 1048576 bytes, a range of 50-100 words.",
    "README.md, build.sh and tool.py are file names, not domains.",
  ])("%s", (text) => {
    expect(kinds(text)).toEqual([]);
  });
});

describe("the line, never the value", () => {
  it("reports the line number and the kind, in line order, and no text", () => {
    const text = ["fine", `mail a${AT}b.example`, "fine again", "see https://x.example/y"].join(
      "\n",
    );
    const leaks = scanForLeaks(text);
    expect(leaks).toEqual([
      { kind: "email", line: 2 },
      { kind: "url", line: 4 },
    ]);
    expect(JSON.stringify(leaks)).not.toMatch(/example|a.b\./);
  });

  it("counts lines the same way for CRLF text", () => {
    expect(scanForLeaks("ok\r\nok\r\ncall +44 20 7946 0958").map((l) => l.line)).toEqual([3]);
  });

  it("lists every kind a line holds, once each, in the order of LEAK_KINDS", () => {
    const line = `mail a${AT}b.example, call +44 20 7946 0958, see https://x.example/y`;
    expect(kinds(line)).toEqual(["url", "email", "phone"]);
    expect(LEAK_KINDS).toEqual(["url", "email", "domain", "ip", "phone", "name"]);
  });
});

describe("the owner's deny-list of names", () => {
  const deny = "# clients, one per line\nTidewater Bar\n\nJuniper Pop-up Kitchen\nNorthgate\n";

  it("finds a name in any case, with an accent added or a hyphen for a space, as a whole word", () => {
    expect(kinds("Fix the menu for tidewater bar", deny)).toEqual(["name"]);
    expect(kinds("TIDEWATER-BAR asked", deny)).toEqual(["name"]);
    expect(kinds("Tidew\u00E4ter Bar asked", deny)).toEqual(["name"]);
    expect(kinds("Northg\u00E1te asked", deny)).toEqual(["name"]);
    expect(kinds("A northgated rollout", deny)).toEqual([]);
    expect(kinds("The Juniper   Pop-up\tKitchen", deny)).toEqual(["name"]);
  });

  it("sees a name split with a zero-width character", () => {
    expect(kinds("Tide\u200Bwater Bar", deny)).toEqual(["name"]);
  });

  it("without a deny-list there is no name check", () => {
    expect(kinds("Tidewater Bar")).toEqual([]);
  });

  it("refuses a deny-list it cannot use, naming the line and not the entry", () => {
    expect(() => compileDenyList("ab\n")).toThrow(DenyListError);
    expect(() => compileDenyList("fine name\nx\n")).toThrow(/line 2/);
    expect(() => compileDenyList(`${"a".repeat(81)}\n`)).toThrow(/line 1/);
    expect(() => compileDenyList("bad\u0000name\n")).toThrow(/line 1/);
    const many = Array.from({ length: 1001 }, (_, i) => `client number ${i}`).join("\n");
    expect(() => compileDenyList(many)).toThrow(/1000/);
    try {
      compileDenyList("Tidewater Bar\nok\n");
    } catch (e) {
      expect(String(e)).not.toContain("Tidewater");
    }
  });

  it("an empty or comment-only list matches nothing", () => {
    expect(kinds("anything at all", "# nothing yet\n\n")).toEqual([]);
  });
});

describe("edge cases", () => {
  it("empty text and a very long line without a leak do not hang", () => {
    expect(scanForLeaks("")).toEqual([]);
    const long = `${"word ".repeat(40_000)}`;
    expect(scanForLeaks(long)).toEqual([]);
    expect(scanForLeaks(`${"a-".repeat(30_000)}b`)).toEqual([]);
    expect(scanForLeaks(`${"1 ".repeat(30_000)}`)).toEqual([]);
    expect(scanForLeaks("a.".repeat(30_000))).toEqual([]);
    expect(scanForLeaks("a@".repeat(30_000))).toEqual([]);
  });
});
