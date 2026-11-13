import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../../snapshot.js";
import { linksWithoutName } from "../names.js";

const page = (body: string) =>
  buildSnapshot([
    {
      url: "https://clinic.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
const empty = (body: string) => linksWithoutName(page(body)).map((l) => `${l.region} ${l.href}`);

describe("linksWithoutName: what counts as a name", () => {
  it("text, aria-label, aria-labelledby, an image's alt, an svg title and a title attribute all name a link", () => {
    expect(
      empty(`<header>
        <a href="/a">Book</a>
        <a href="/b" aria-label="Basket"><svg></svg></a>
        <a href="/c" aria-labelledby="lbl"><svg></svg></a><span id="lbl">Contact</span>
        <a href="/d"><img src="x.png" alt="Home"></a>
        <a href="/e"><svg><title>Search</title></svg></a>
        <a href="/f" title="Facebook"><svg></svg></a>
        <a href="/g"><span aria-label="Call us"></span></a>
      </header>`),
    ).toEqual([]);
  });

  it("an icon with nothing, an empty alt, empty or blank labels and text only in a hidden element are empty", () => {
    expect(
      empty(`<header>
        <a href="/a"><svg></svg></a>
        <a href="/b"><img src="x.png" alt=""></a>
        <a href="/c" aria-label="   "><i class="icon"></i></a>
        <a href="/d">&nbsp; </a>
        <a href="/e"><span aria-hidden="true">Shop</span></a>
        <a href="/f"><span hidden>Shop</span></a>
        <a href="/g" aria-labelledby="missing"></a>
        <a href="/h"><img src="x.png"></a>
      </header>`),
    ).toEqual([
      "header https://clinic.example/a",
      "header https://clinic.example/b",
      "header https://clinic.example/c",
      "header https://clinic.example/d",
      "header https://clinic.example/e",
      "header https://clinic.example/f",
      "header https://clinic.example/g",
      "header https://clinic.example/h",
    ]);
  });

  it("zero-width characters are not a name", () => {
    expect(empty(`<nav><a href="/a">\u200B\u2060</a></nav>`)).toEqual([
      "header https://clinic.example/a",
    ]);
  });
});

describe("linksWithoutName: which links", () => {
  it("reads the header, nav and footer, never the body, and skips anchors that are not links", () => {
    expect(
      empty(`<header><a name="top"></a><a href="#"></a></header>
        <main><a href="/body"><svg></svg></a></main>
        <footer><a href="/social"><svg></svg></a></footer>`),
    ).toEqual(["header https://clinic.example/#", "footer https://clinic.example/social"]);
  });

  it("a link with no href is not a link, and the elements it holds are not read", () => {
    expect(empty(`<nav><a><svg></svg></a></nav>`)).toEqual([]);
  });

  it("uses the selectors of gaugeline.nav.json when it names them", () => {
    const p = page(
      `<div id="menu"><a href="/x"><svg></svg></a></div><nav><a href="/y"><svg></svg></a></nav>`,
    );
    expect(linksWithoutName(p, { regions: { header: "#menu" } }).map((l) => l.href)).toEqual([
      "https://clinic.example/x",
    ]);
  });

  it("a page with no menu has none", () => {
    expect(empty("<p>hello</p>")).toEqual([]);
  });
});
