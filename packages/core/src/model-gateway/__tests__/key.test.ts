import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ApiKey, scrub } from "../key.js";
import { ODD_KEY, PLAIN_KEY, SHAPED_KEY } from "./helpers.js";

describe("ApiKey", () => {
  it("gives its value only to reveal()", () => {
    const k = new ApiKey(PLAIN_KEY);
    expect(k.reveal()).toBe(PLAIN_KEY);
    for (const shown of [
      String(k),
      `${k}`,
      JSON.stringify(k),
      JSON.stringify({ k }),
      inspect(k),
      inspect({ nested: { k } }, { depth: 6 }),
      Object.keys(k).join(),
      JSON.stringify(Object.getOwnPropertyNames(k)),
      JSON.stringify({ ...k }),
    ])
      expect(shown).not.toContain(PLAIN_KEY);
    expect(String(k)).toBe("[redacted key]");
  });
});

describe("scrub", () => {
  it("removes every secret in the forms a request writes it, and the key shapes", () => {
    const forms = [
      ODD_KEY,
      encodeURIComponent(ODD_KEY),
      Buffer.from(ODD_KEY).toString("base64"),
      JSON.stringify(ODD_KEY).slice(1, -1),
    ];
    const out = scrub(`${forms.join(" ")} Bearer ${SHAPED_KEY}`, [ODD_KEY]);
    for (const form of forms) expect(out).not.toContain(form);
    expect(out).not.toContain(SHAPED_KEY);
  });

  it("leaves ordinary words alone, and ignores a secret too short to be one", () => {
    expect(scrub("The provider answered 429.", [PLAIN_KEY])).toBe("The provider answered 429.");
    expect(scrub("abc abc", ["abc"])).toBe("abc abc");
  });

  it("shows control and hidden characters, and cuts a long text", () => {
    const bidi = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(7);
    const out = scrub(`a${bidi}b${bell}${"x".repeat(900)}`, []);
    expect(out).not.toContain(bidi);
    expect(out).not.toContain(bell);
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
