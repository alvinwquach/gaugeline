import { describe, expect, it } from "vitest";
import type { CheckContext } from "../../model.js";
import { buildSnapshot } from "../../snapshot.js";
import { createPageRegistry } from "../index.js";
import { navLinkNoName } from "../nav-link-no-name.js";

const page = (body: string) =>
  buildSnapshot([
    {
      url: "https://clinic.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Clinic</title></head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  warn: () => undefined,
  ...over,
});
const icon = (href: string) => `<a href="${href}"><svg viewBox="0 0 1 1"></svg></a>`;

describe("nav-link-no-name", () => {
  it("is a registered page check with no request of its own", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("nav-link-no-name");
    expect(navLinkNoName.tech).toMatch(/^no request\./);
  });

  it("passes when every header and footer link is named", async () => {
    const found = await navLinkNoName.run(
      page(
        `<header><a href="/">Home</a>${icon("/basket").replace("<a ", '<a aria-label="Basket" ')}</header><footer><a href="/privacy">Privacy</a></footer>`,
      ),
      ctx(),
    );
    expect(found).toEqual([]);
  });

  it("names the region and destination of each link with no name, and the count", async () => {
    const found = await navLinkNoName.run(
      page(
        `<header><nav><a href="/book">Book</a>${icon("/basket")}${icon("https://clinic.example/phone")}</nav></header><footer>${icon("https://social.example/clinic")}</footer>`,
      ),
      ctx(),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "nav-link-no-name",
      severity: "medium",
      url: "https://clinic.example/",
    });
    expect(found[0]?.evidence).toBe(
      "3 links have no accessible name: header link to /basket, header link to /phone, footer link to https://social.example/clinic",
    );
  });

  it("cuts a long list after three", async () => {
    const found = await navLinkNoName.run(
      page(`<header>${["/a", "/b", "/c", "/d", "/e"].map(icon).join("")}</header>`),
      ctx(),
    );
    expect(found[0]?.evidence).toBe(
      "5 links have no accessible name: header link to /a, header link to /b, header link to /c and 2 more",
    );
  });

  it("says link, not links, for one", async () => {
    const found = await navLinkNoName.run(page(`<header>${icon("/a")}</header>`), ctx());
    expect(found[0]?.evidence).toMatch(/^1 link has no accessible name/);
  });

  it("does not read the body, and reads the regions gaugeline.nav.json names", async () => {
    const html = `<div id="menu">${icon("/x")}</div><main>${icon("/body")}</main>`;
    expect(await navLinkNoName.run(page(html), ctx())).toEqual([]);
    const found = await navLinkNoName.run(
      page(html),
      ctx({ navRules: { regions: { header: "#menu" } } }),
    );
    expect(found[0]?.evidence).toContain("header link to /x");
    expect(found[0]?.evidence).not.toContain("/body");
  });

  it("is the same on every run for the same page", async () => {
    const p = page(`<header>${icon("/a")}</header>`);
    expect(await navLinkNoName.run(p, ctx())).toEqual(await navLinkNoName.run(p, ctx()));
  });
});
