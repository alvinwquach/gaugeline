import { describe, expect, it } from "vitest";
import { VOLATILE_RULES, firstDifference, stripVolatile } from "../volatile.js";

/** One row per volatile token Gaugeline removes before it compares two visits: what a page prints that is new every time and means nothing. */
const TABLE: Array<[id: string, before: string, after: string]> = [
  [
    "nonce-attribute",
    "<script nonce=\"r4nd0m1\">init()</script><style nonce='abc'></style>",
    '<script nonce="">init()</script><style nonce=""></style>',
  ],
  [
    "csp-nonce",
    `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-Zm9vYmFy' 'self'">`,
    `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-' 'self'">`,
  ],
  [
    "csrf-meta",
    '<meta name="csrf-token" content="Zq81xTT0">',
    '<meta name="csrf-token" content="">',
  ],
  [
    "csrf-meta",
    '<meta content="Zq81xTT0" name="csrf-token">',
    '<meta content="" name="csrf-token">',
  ],
  [
    "csrf-input",
    '<input type="hidden" name="authenticity_token" value="a8f3">',
    '<input type="hidden" name="authenticity_token" value="">',
  ],
  [
    "csrf-input",
    '<input value="9981" name="__RequestVerificationToken" type="hidden">',
    '<input value="" name="__RequestVerificationToken" type="hidden">',
  ],
  [
    "cloudflare-email",
    '<a href="/cdn-cgi/l/email-protection#8a8b8c" data-cfemail="8a8b8c">[email&#160;protected]</a>',
    '<a href="/cdn-cgi/l/email-protection#" data-cfemail="">[email&#160;protected]</a>',
  ],
];

describe("stripVolatile: the table of volatile tokens", () => {
  it.each(TABLE)("%s: %s", (_id, before, after) => {
    expect(stripVolatile(before)).toBe(stripVolatile(after));
    expect(stripVolatile(before)).toBe(after);
  });

  it("every rule in the table has a row above", () => {
    const covered = new Set(TABLE.map((r) => r[0]));
    expect(VOLATILE_RULES.map((r) => r.id).filter((id) => !covered.has(id))).toEqual([]);
  });

  it("a rule has an id and a plain sentence saying what it removes", () => {
    for (const rule of VOLATILE_RULES) {
      expect(rule.id).toMatch(/^[a-z-]+$/);
      expect(rule.what.length).toBeGreaterThan(10);
    }
  });

  it("leaves an input that is not a token alone, so a real change in its value still shows", () => {
    const html = '<input type="text" name="booking-name" value="Rosa Marlowe">';
    expect(stripVolatile(html)).toBe(html);
  });

  it("collapses whitespace and trims, so a re-indented page is the same page", () => {
    expect(stripVolatile("  <p>Open\n\n   Tuesday</p>  \n")).toBe("<p>Open Tuesday</p>");
  });

  it("two pages that differ only by a nonce and a CSRF value are the same page", () => {
    const a = '<script nonce="aaa"></script><meta name="csrf-token" content="111"><p>Menu</p>';
    const b = '<script nonce="bbb"></script><meta name="csrf-token" content="222"><p>Menu</p>';
    expect(stripVolatile(a)).toBe(stripVolatile(b));
  });
});

describe("firstDifference", () => {
  it("is undefined for identical text", () => {
    expect(firstDifference("<p>same</p>", "<p>same</p>")).toBeUndefined();
  });

  it("finds a timestamp that changed, whole, with its kind and the text before it", () => {
    const a = "<h1>Tonight</h1><p>Updated 2026-11-11T09:00:03Z by the bar</p>";
    const b = "<h1>Tonight</h1><p>Updated 2026-11-11T09:00:08Z by the bar</p>";
    expect(firstDifference(a, b)).toEqual({
      context: "<h1>Tonight</h1><p>Updated",
      first: "2026-11-11T09:00:03Z",
      second: "2026-11-11T09:00:08Z",
      kind: "time",
    });
  });

  it("calls a clock time a time", () => {
    const d = firstDifference("<p>It is 12:04:55 here</p>", "<p>It is 12:05:01 here</p>");
    expect(d?.kind).toBe("time");
    expect(d?.first).toBe("12:04:55");
  });

  it("calls a long random-looking value an id", () => {
    const d = firstDifference(
      '<div data-request="9f2c61ab77e04d1c">x</div>',
      '<div data-request="31b0aa5e92c7f604">x</div>',
    );
    expect(d?.kind).toBe("id");
  });

  it("calls a number that moved a counter", () => {
    const d = firstDifference("<p>Seen by 4120 visitors</p>", "<p>Seen by 4121 visitors</p>");
    expect(d).toMatchObject({ kind: "number", first: "4120", second: "4121" });
  });

  it("calls anything else other, and works when one text is a prefix of the other", () => {
    expect(firstDifference("<p>Open</p>", "<p>Closed</p>")?.kind).toBe("other");
    const d = firstDifference("<p>Open</p>", "<p>Open</p><p>More</p>");
    expect(d?.second).toContain("More");
  });

  it("starts a long context at a tag, not in the middle of a word, and marks a cut with no tag", () => {
    const long = `<main><section class="menu-of-the-day"><h1>Tonight's specials</h1><p>Updated 09:00:03</p>`;
    const d = firstDifference(long, long.replace("09:00:03", "09:00:08"));
    expect(d?.context.startsWith("<")).toBe(true);
    expect(d?.context.length).toBeLessThanOrEqual(40);
    const bare = `${"word ".repeat(30)}12:00:01`;
    expect(
      firstDifference(bare, bare.replace("12:00:01", "12:00:02"))?.context.startsWith("\u2026"),
    ).toBe(true);
  });

  it("is deterministic: the same two texts give the same difference", () => {
    const a = "<p>a 1</p>";
    const b = "<p>a 2</p>";
    expect(firstDifference(a, b)).toEqual(firstDifference(a, b));
  });
});
