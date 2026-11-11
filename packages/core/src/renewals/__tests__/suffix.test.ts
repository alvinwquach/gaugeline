import { describe, expect, it } from "vitest";
import { registrableOf } from "../suffix.js";

describe("registrableOf: unit", () => {
  it("takes the last two labels of a plain domain", () => {
    expect(registrableOf("marlowe-bar.example")).toEqual({
      kind: "domain",
      domain: "marlowe-bar.example",
      tld: "example",
    });
    expect(registrableOf("www.marlowe-bar.dev")).toMatchObject({ domain: "marlowe-bar.dev" });
    expect(registrableOf("book.eu.marlowe-bar.com")).toMatchObject({ domain: "marlowe-bar.com" });
  });

  it("keeps a second-level public suffix with the name (co.uk, com.au)", () => {
    expect(registrableOf("www.cedar-clinic.co.uk")).toMatchObject({
      domain: "cedar-clinic.co.uk",
      tld: "uk",
    });
    expect(registrableOf("shop.bondi-pop-up.com.au")).toMatchObject({
      domain: "bondi-pop-up.com.au",
      tld: "au",
    });
    expect(registrableOf("cedar-clinic.org.uk")).toMatchObject({ domain: "cedar-clinic.org.uk" });
  });

  it("ignores case, a trailing dot and a leading www", () => {
    expect(registrableOf("WWW.Marlowe-Bar.Example.")).toMatchObject({
      domain: "marlowe-bar.example",
    });
  });

  it("reads an internationalised name as its ASCII form", () => {
    expect(registrableOf("www.caf\u00E9-lune.example")).toMatchObject({
      domain: "xn--caf-lune-d1a.example",
    });
  });

  it("says a platform subdomain is not the client's registration", () => {
    expect(registrableOf("marlowe-bar-git-main.vercel.app")).toEqual({
      kind: "platform",
      host: "marlowe-bar-git-main.vercel.app",
      platform: "vercel.app",
    });
    expect(registrableOf("kiln-pop-up.netlify.app")).toMatchObject({ kind: "platform" });
  });

  it("has nothing to look up for an address, a bare label or a suffix alone", () => {
    expect(registrableOf("127.0.0.1")).toMatchObject({ kind: "none" });
    expect(registrableOf("[::1]")).toMatchObject({ kind: "none" });
    expect(registrableOf("intranet")).toMatchObject({ kind: "none" });
    expect(registrableOf("co.uk")).toMatchObject({ kind: "none" });
    expect(registrableOf("")).toMatchObject({ kind: "none" });
  });
});
