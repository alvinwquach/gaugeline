import { describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import {
  MIGRATION_ITEM_CAP,
  itemPath,
  parseWordPress,
  plainText,
  readExportFile,
} from "../list.js";
import { ITEMS, wpBody } from "./world.js";

describe("itemPath", () => {
  it("takes the path of an address, a path or a protocol-relative address", () => {
    expect(itemPath("https://wrenbakehouse.example/about/")).toEqual({ path: "/about/" });
    expect(itemPath("/menu/")).toEqual({ path: "/menu/" });
    expect(itemPath("https://wrenbakehouse.example")).toEqual({ path: "/" });
    expect(itemPath("https://wrenbakehouse.example/a/b/#team")).toEqual({ path: "/a/b/" });
  });
  it("leaves out a query string and what is not a web address", () => {
    expect(itemPath("https://wrenbakehouse.example/?p=12")).toEqual({ skip: "a query string" });
    expect(itemPath("mailto:the-bakery")).toEqual({ skip: "not a web address" });
    expect(itemPath("  ")).toEqual({ skip: "empty" });
  });
});

describe("parseWordPress", () => {
  it("reads link, rendered title and type, and decodes the title's entities", () => {
    const rows = parseWordPress(wpBody("post"));
    expect(rows).toHaveLength(8);
    expect(rows?.find((r) => r.link.endsWith("/market-stall-summer/"))).toEqual({
      link: "https://wrenbakehouse.example/2026/07/market-stall-summer/",
      title: "Cardamom buns & summer hours at the market stall",
      type: "post",
    });
  });
  it("leaves out an item that is not published", () => {
    const body = JSON.stringify([
      { link: "https://a.example/x/", status: "draft", title: { rendered: "Draft" } },
      { link: "https://a.example/y/", status: "publish", title: { rendered: "Live" } },
    ]);
    expect(parseWordPress(body)?.map((r) => r.title)).toEqual(["Live"]);
  });
  it("is undefined for what is not the API's list: a theme's page, an error object, a list of other things", () => {
    expect(parseWordPress("<html>Not found</html>")).toBeUndefined();
    expect(parseWordPress('{"code":"rest_no_route","message":"No route"}')).toBeUndefined();
    expect(parseWordPress('[{"id":1}]')).toBeUndefined();
  });
  it("reads a title as text, never as markup", () => {
    expect(plainText("Fresh <script>alert(1)</script><b>bread</b> &#8211; daily")).toBe(
      "Fresh alert(1)bread \u2013 daily",
    );
  });
});

describe("readExportFile", () => {
  it("reads a CSV with a url and a title column, by header name and not by position", () => {
    const list = readExportFile(
      'Title,Slug,URL\n"Sunday roast, with gravy",sunday-roast,/menu/sunday-roast\nWine list,wine,https://oldbar.example/wine\n',
    );
    expect(list.source).toBe("file");
    expect(list.items).toEqual([
      { path: "/menu/sunday-roast", title: "Sunday roast, with gravy" },
      { path: "/wine", title: "Wine list" },
    ]);
  });
  it("reads JSON as an array, or under items, or Webflow's fieldData", () => {
    const rows = [
      { link: "https://a.example/one/", title: { rendered: "One" } },
      { path: "/two/", name: "Two" },
    ];
    expect(readExportFile(JSON.stringify(rows)).items.map((i) => i.path)).toEqual([
      "/one/",
      "/two/",
    ]);
    expect(readExportFile(JSON.stringify({ items: rows })).items).toHaveLength(2);
    const webflow = { items: [{ fieldData: { name: "Gift cards", url: "/shop/gift-cards" } }] };
    expect(readExportFile(JSON.stringify(webflow)).items).toEqual([
      { path: "/shop/gift-cards", title: "Gift cards" },
    ]);
  });
  it("counts a row with no address, a duplicate once, and says what was left out", () => {
    const list = readExportFile("url,title\n/a/,A\n,No address\n/a/,A again\n/b/?x=1,Query\n");
    expect(list.items.map((i) => i.path)).toEqual(["/a/"]);
    expect(list.skipped).toBe(2);
    expect(list.notes.join(" ")).toContain("2 addresses were left out");
  });
  it("refuses a file with no address column, and a slug alone", () => {
    expect(() => readExportFile("Title,Slug\nA,a\n")).toThrow(ConfigError);
    expect(() => readExportFile(JSON.stringify([{ title: "A", slug: "a" }]))).toThrow(
      /address or a path/,
    );
    expect(() => readExportFile("{not json")).toThrow(/not valid JSON/);
  });
  it("cuts a long list at the cap and says how long it was", () => {
    const csv = `url\n${Array.from({ length: MIGRATION_ITEM_CAP + 20 }, (_, n) => `/p/${n}/`).join("\n")}\n`;
    const list = readExportFile(csv);
    expect(list.items).toHaveLength(MIGRATION_ITEM_CAP);
    expect(list.total).toBe(MIGRATION_ITEM_CAP + 20);
    expect(list.notes.join(" ")).toContain(`has ${MIGRATION_ITEM_CAP + 20} items`);
  });
  it("the world's twelve items are the twelve a list holds", () => {
    expect(ITEMS).toHaveLength(12);
  });
});
