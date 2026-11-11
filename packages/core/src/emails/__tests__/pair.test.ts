import { describe, expect, it } from "vitest";
import { nameEmail, pairEmails } from "../pair.js";

describe("pairing emails by base name and language suffix", () => {
  it("splits order.es.html into a base and a language", () => {
    expect(nameEmail("order.es.html")).toEqual({
      base: "order",
      lang: "es",
      file: "order.es.html",
    });
    expect(nameEmail("mail/order.en-US.htm").lang).toBe("en-us");
    expect(nameEmail("mail/order.pt_BR.html")).toMatchObject({ base: "mail/order", lang: "pt-br" });
  });

  it("a name with no language suffix has none, and neither do words that are not languages", () => {
    expect(nameEmail("welcome.html").lang).toBeUndefined();
    expect(nameEmail("order.copy.html").lang).toBeUndefined();
    expect(nameEmail("order.zz.html").lang).toBeUndefined();
  });

  it("groups the twins of one email and lists the languages the folder uses", () => {
    const p = pairEmails([
      "order.en.html",
      "order.es.html",
      "booking.en.html",
      "welcome.html",
      "sub/order.en.html",
    ]);
    expect([...(p.groups.get("order")?.entries() ?? [])]).toEqual([
      ["en", "order.en.html"],
      ["es", "order.es.html"],
    ]);
    expect([...(p.groups.get("booking")?.keys() ?? [])]).toEqual(["en"]);
    expect(p.groups.has("welcome")).toBe(false);
    expect(p.groups.get("sub/order")?.size).toBe(1);
    expect(p.languages).toEqual(["en", "es"]);
  });
});
