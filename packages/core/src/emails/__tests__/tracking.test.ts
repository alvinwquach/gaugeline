import { describe, expect, it } from "vitest";
import { parseEmail } from "../parse.js";
import { unwrapTracking } from "../tracking.js";

const DEST = "https://shop.example/orders/7?ref=mail";

describe("tracking-wrapped links", () => {
  it("unwraps Microsoft's link scanning and Google's redirect", () => {
    const safe = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(DEST)}&data=abc`;
    expect(unwrapTracking(safe)).toEqual({
      href: DEST,
      via: "eur01.safelinks.protection.outlook.com",
    });
    expect(unwrapTracking(`https://www.google.com/url?q=${encodeURIComponent(DEST)}`).href).toBe(
      DEST,
    );
  });

  it("unwraps a provider's pattern the project names, on its host and subdomains, and only on its path", () => {
    const rule = { host: "click.mail.example", param: "u", path: "/track" };
    const wrapped = `https://click.mail.example/track?u=${encodeURIComponent(DEST)}`;
    expect(unwrapTracking(wrapped, [rule]).href).toBe(DEST);
    expect(
      unwrapTracking(`https://eu.click.mail.example/track?u=${encodeURIComponent(DEST)}`, [rule])
        .href,
    ).toBe(DEST);
    const other = `https://click.mail.example/other?u=${encodeURIComponent(DEST)}`;
    expect(unwrapTracking(other, [rule])).toEqual({ href: other });
  });

  it("a wrapper nobody knows is checked as it is", () => {
    const opaque = "https://click.mail.example/c/AbCdEf123?x=1";
    expect(unwrapTracking(opaque)).toEqual({ href: opaque });
    const noDestination = "https://click.mail.example/t?u=not-an-address";
    expect(unwrapTracking(noDestination, [{ host: "click.mail.example", param: "u" }])).toEqual({
      href: noDestination,
    });
  });

  it("follows wrappers inside wrappers a few levels and then stops", () => {
    let url = DEST;
    for (let i = 0; i < 6; i++)
      url = `https://safelinks.protection.outlook.com/?url=${encodeURIComponent(url)}`;
    const r = unwrapTracking(url);
    expect(r.via).toBe("safelinks.protection.outlook.com");
    expect(r.href.startsWith("https://safelinks.protection.outlook.com/?url=")).toBe(true);
  });

  it("the email's links hold the destination, and the line stays the link's own", () => {
    const html = `<p>x</p>\n<a href="https://google.com/url?q=${encodeURIComponent("http://localhost:3000/a")}">go</a>`;
    const link = parseEmail(html).links[0];
    expect(link).toMatchObject({ href: "http://localhost:3000/a", via: "google.com", line: 2 });
    expect(link?.raw.startsWith("https://google.com/url")).toBe(true);
  });
});
