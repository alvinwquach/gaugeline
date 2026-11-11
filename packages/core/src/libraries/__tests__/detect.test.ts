import { describe, expect, it } from "vitest";
import { detect, looksMinified, MAX_SCRIPT_CHARS } from "../detect.js";

/**
 * Invented script text: each file holds only the banner, version string or code shape a detection reads, never
 * a library's real code. The banner lines are the shapes the libraries' own build tools write.
 */
const JQUERY_BANNER =
  "/*! jQuery v1.12.4 | (c) jQuery Foundation | jquery.org/license */\n!function(a,b){}(window);";
const JQUERY_FULL =
  "/*!\n * jQuery JavaScript Library v3.6.0\n * https://jquery.com/\n */\n(function(){})();";
const MOMENT_BANNER =
  "//! moment.js\n//! version : 2.29.4\n//! authors : Tim Wood, Iskren Chernev, Moment.js contributors\n//! license : MIT\n//! momentjs.com\n;(function(){})();";
const LODASH_MIN =
  '/** @license Lodash lodash.com/license | Underscore.js 1.8.3 underscorejs.org/LICENSE */\n;(function(){var n={};n.VERSION="4.17.21";})();';

describe("detect: banners and version strings", () => {
  it("reads the jQuery banner of a minified and of a full file", () => {
    expect(detect(JQUERY_BANNER, "https://shop.example/js/site.js")).toEqual([
      {
        library: "jquery",
        name: "jQuery",
        version: "1.12.4",
        evidence: { how: "banner", matched: "1.12.4" },
      },
    ]);
    expect(detect(JQUERY_FULL, "https://shop.example/js/site.js")[0]).toMatchObject({
      library: "jquery",
      version: "3.6.0",
    });
  });

  it("reads jQuery's version string when the banner was stripped", () => {
    const text = 'var S=function(){};S.fn=S.prototype={jquery:"3.5.1",constructor:S,length:0};';
    expect(detect(text, "https://shop.example/js/app.js")).toEqual([
      {
        library: "jquery",
        name: "jQuery",
        version: "3.5.1",
        evidence: { how: "version-string", matched: "3.5.1" },
      },
    ]);
  });

  it("does not take jQuery UI's banner for jQuery, or jQuery Migrate's", () => {
    const ui = "/*! jQuery UI - v1.12.1 - 2016-09-14\n* http://jqueryui.com */";
    expect(detect(ui, "https://shop.example/js/ui.js")).toEqual([
      {
        library: "jquery-ui",
        name: "jQuery UI",
        version: "1.12.1",
        evidence: { how: "banner", matched: "1.12.1" },
      },
    ]);
    expect(
      detect("/*! jQuery Migrate v3.0.0 | (c) jQuery Foundation */", "https://shop.example/m.js"),
    ).toEqual([]);
  });

  it("reads Moment's banner and the Lodash version beside its license line", () => {
    expect(detect(MOMENT_BANNER, "https://shop.example/js/dates.js")[0]).toMatchObject({
      library: "moment",
      version: "2.29.4",
      evidence: { how: "banner" },
    });
    expect(detect(LODASH_MIN, "https://shop.example/js/vendor.js")).toEqual([
      {
        library: "lodash",
        name: "Lodash",
        version: "4.17.21",
        evidence: { how: "version-string", matched: "4.17.21" },
      },
    ]);
  });

  it("does not read a VERSION constant that has no Lodash beside it", () => {
    expect(detect('var cfg={};cfg.VERSION="4.1.0";', "https://shop.example/js/app.js")).toEqual([]);
  });

  it("reads Bootstrap's banners (the bundle's and a plugin's) and AngularJS's", () => {
    expect(
      detect(
        "/*!\n * Bootstrap v3.3.7 (http://getbootstrap.com)\n */",
        "https://shop.example/b.js",
      )[0],
    ).toMatchObject({ library: "bootstrap", version: "3.3.7" });
    expect(
      detect("/* ========\n * Bootstrap: tooltip.js v3.3.7\n */", "https://shop.example/t.js")[0],
    ).toMatchObject({ library: "bootstrap", version: "3.3.7" });
    expect(
      detect(
        "/**\n * @license AngularJS v1.5.8\n * (c) 2010-2016 Google, Inc. http://angularjs.org\n */",
        "https://shop.example/a.js",
      )[0],
    ).toMatchObject({ library: "angularjs", version: "1.5.8" });
    expect(
      detect('var v={full:"1.8.2",major:1,minor:8,dot:2};', "https://shop.example/a.js")[0],
    ).toMatchObject({
      library: "angularjs",
      version: "1.8.2",
      evidence: { how: "version-string" },
    });
  });

  it("finds two libraries in one bundle, in the table's order", () => {
    const found = detect(`${JQUERY_BANNER}\n${MOMENT_BANNER}`, "https://shop.example/js/vendor.js");
    expect(found.map((d) => `${d.library} ${d.version}`)).toEqual([
      "jquery 1.12.4",
      "moment 2.29.4",
    ]);
  });

  it("shows only the version in the evidence, never the text around it", () => {
    const [d] = detect(`${JQUERY_BANNER}\nvar secret="do-not-print";`, "https://shop.example/a.js");
    expect(JSON.stringify(d)).not.toContain("do-not-print");
    expect(JSON.stringify(d)).not.toContain("Foundation");
  });
});

describe("detect: addresses", () => {
  it.each([
    ["https://code.jquery.com/jquery-3.5.1.min.js", "jquery", "3.5.1"],
    ["https://code.jquery.com/jquery-3.5.1.slim.min.js", "jquery", "3.5.1"],
    ["https://ajax.googleapis.com/ajax/libs/jquery/1.12.4/jquery.min.js", "jquery", "1.12.4"],
    [
      "https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.12.1/jquery-ui.min.js",
      "jquery-ui",
      "1.12.1",
    ],
    ["https://shop.example/js/jquery-ui-1.11.4.custom.min.js", "jquery-ui", "1.11.4"],
    ["https://cdn.jsdelivr.net/npm/lodash@4.17.15/lodash.min.js", "lodash", "4.17.15"],
    ["https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.18.1/moment.min.js", "moment", "2.18.1"],
    [
      "https://stackpath.bootstrapcdn.com/bootstrap/3.3.7/js/bootstrap.min.js",
      "bootstrap",
      "3.3.7",
    ],
    [
      "https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.3.7/js/bootstrap.min.js",
      "bootstrap",
      "3.3.7",
    ],
    ["https://unpkg.com/bootstrap@4.0.0/dist/js/bootstrap.bundle.min.js", "bootstrap", "4.0.0"],
    ["https://ajax.googleapis.com/ajax/libs/angularjs/1.5.8/angular.min.js", "angularjs", "1.5.8"],
    ["https://code.jquery.com/jquery-3.0.0-beta1.min.js", "jquery", "3.0.0-beta1"],
  ])("%s is %s %s", (url, library, version) => {
    const found = detect("", url);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      library,
      version,
      evidence: { how: "file-name", matched: version },
    });
  });

  it("does not take jQuery UI's file name for jQuery, or a jQuery plugin for the library", () => {
    expect(
      detect("", "https://shop.example/js/jquery-ui-1.12.1.min.js").map((d) => d.library),
    ).toEqual(["jquery-ui"]);
    expect(detect("", "https://shop.example/js/jquery-migrate-3.0.0.min.js")).toEqual([]);
    expect(detect("", "https://shop.example/js/jquery.slick-1.8.1.min.js")).toEqual([]);
  });

  it("prefers the file's own banner over its address", () => {
    const [d] = detect(
      JQUERY_BANNER,
      "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js",
    );
    expect(d).toMatchObject({ version: "1.12.4", evidence: { how: "banner" } });
  });

  it("knows a library by a bare file name and says the version is not there", () => {
    expect(
      detect("!function(){}();", "https://shop.example/wp-content/themes/old/js/jquery.min.js"),
    ).toEqual([
      {
        library: "jquery",
        name: "jQuery",
        version: null,
        evidence: { how: "file-name", matched: "jquery.min.js" },
      },
    ]);
    expect(detect("", "https://shop.example/js/bootstrap.bundle.min.js")[0]).toMatchObject({
      library: "bootstrap",
      version: null,
    });
  });

  it("knows Lodash by its license line when no version is written", () => {
    expect(
      detect(
        "/** @license Lodash lodash.com/license */\n;(function(){})();",
        "https://shop.example/x.js",
      ),
    ).toEqual([
      { library: "lodash", name: "Lodash", version: null, evidence: { how: "name", matched: "" } },
    ]);
  });

  it("ignores the query string and the fragment of an address", () => {
    expect(detect("", "https://shop.example/js/jquery.min.js?ver=3.5.1#x")[0]).toMatchObject({
      version: null,
    });
    expect(detect("", "https://shop.example/js/jquery-3.5.1.min.js?ver=9.9.9")[0]).toMatchObject({
      version: "3.5.1",
    });
  });

  it("does not throw on an address that is not one", () => {
    expect(detect("", "not a url")).toEqual([]);
  });
});

describe("detect: edge cases", () => {
  it("finds nothing in ordinary site code", () => {
    expect(
      detect("document.addEventListener('click',function(){});", "https://shop.example/js/site.js"),
    ).toEqual([]);
  });

  it("does not take a version from a prose comment", () => {
    expect(
      detect("// needs jquery 1.8 or newer, see the docs", "https://shop.example/js/site.js"),
    ).toEqual([]);
  });

  it("reads a large file in one pass and a banner far down it", () => {
    const filler = "var a=1;".repeat(200_000);
    const [d] = detect(`${filler}\n${JQUERY_BANNER}`, "https://shop.example/js/app.js");
    expect(d).toMatchObject({ library: "jquery", version: "1.12.4" });
  });

  it("is not slowed down by long runs of comment openers and spaces", () => {
    const hostile = "/*".repeat(20_000) + " ".repeat(40_000) + "/*" + "*".repeat(40_000);
    const t = Date.now();
    detect(hostile, "https://shop.example/js/app.js");
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("gives the same answer for the same input", () => {
    const a = detect(`${JQUERY_BANNER}${MOMENT_BANNER}`, "https://shop.example/a.js");
    expect(detect(`${JQUERY_BANNER}${MOMENT_BANNER}`, "https://shop.example/a.js")).toEqual(a);
  });

  it("states the size it reads", () => {
    expect(MAX_SCRIPT_CHARS).toBe(2 * 1024 * 1024);
  });
});

describe("looksMinified", () => {
  it("is true for one very long line and false for readable code", () => {
    expect(looksMinified("a=1;".repeat(400))).toBe(true);
    expect(looksMinified("function a() {\n  return 1;\n}\n".repeat(200))).toBe(false);
    expect(looksMinified("")).toBe(false);
  });
});
