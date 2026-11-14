import { describe, expect, it } from "vitest";
import { detect } from "../detect.js";

/**
 * Review findings on E-12: a version must come from a real banner, a tight code shape or a library's own file
 * name, never from a sentence in a comment, a neighbour library's constant or a folder that happens to be named
 * like a library. Every row here once produced a false version.
 */
const LODASH_LICENSE =
  "/** @license Lodash lodash.com/license | Underscore.js 1.8.3 underscorejs.org/LICENSE */\n";
const at = (text: string, url = "https://shop.example/js/a.js") => detect(text, url);
const versions = (text: string, url?: string) =>
  at(text, url).map((d) => `${d.library} ${d.version}`);

describe("detect: a comment that mentions a library is not its banner", () => {
  it.each([
    ["Bootstrap", "/* Requires Bootstrap v4.0+ */"],
    ["Bootstrap", "/*!\n * Needs Bootstrap v3.3 or newer\n */"],
    ["Bootstrap", "\n * Bootstrap v4.0 (not the version of this file)\n"],
    ["jQuery", "/* jQuery v1.7 required */"],
    ["jQuery", "/* Works with jQuery v1.9 - see the docs */"],
    ["jQuery UI", "/* needs jQuery UI 1.8 */"],
    ["AngularJS", "// compatible with @license AngularJS v1.2 only"],
  ])("%s: %s", (_name, text) => {
    expect(at(text).filter((d) => d.version !== null)).toEqual([]);
  });

  it("still reads the real Bootstrap banners", () => {
    expect(
      versions("/*!\n * Bootstrap v4.6.0 (https://getbootstrap.com/)\n * Copyright 2011\n */"),
    ).toEqual(["bootstrap 4.6.0"]);
    expect(versions("/*! Bootstrap v3.3.7 (http://getbootstrap.com) */")).toEqual([
      "bootstrap 3.3.7",
    ]);
    expect(
      versions(
        "/* ========================================\n * Bootstrap: tooltip.js v3.3.7\n * http://getbootstrap.com/javascript/#tooltip\n */",
      ),
    ).toEqual(["bootstrap 3.3.7"]);
  });

  it("still reads jQuery's and jQuery UI's real banners, including a custom build", () => {
    expect(
      versions(
        "/*! jQuery v3.5.1 -ajax,-ajax/jsonp,-effects | (c) JS Foundation and other contributors | jquery.org/license */",
      ),
    ).toEqual(["jquery 3.5.1"]);
    expect(
      versions("/*!\n * jQuery JavaScript Library v3.6.0\n * https://jquery.com/\n */"),
    ).toEqual(["jquery 3.6.0"]);
    expect(versions("/*!\n * jQuery UI Core 1.12.1\n * http://jqueryui.com\n */")).toEqual([
      "jquery-ui 1.12.1",
    ]);
    expect(versions("/*! jQuery UI - v1.13.2 - 2022-07-14\n * http://jqueryui.com */")).toEqual([
      "jquery-ui 1.13.2",
    ]);
  });
});

describe("detect: Lodash is read from its own shapes only", () => {
  it("does not read a neighbour's VERSION beside a Lodash license line", () => {
    expect(versions(`${LODASH_LICENSE};Backbone.VERSION='1.1.2';`)).toEqual(["lodash null"]);
    expect(versions(`${LODASH_LICENSE};var VERSION="1.8.3";_.VERSION=VERSION;`)).toEqual([
      "lodash null",
    ]);
    expect(versions(`${LODASH_LICENSE};n.VERSION="4.17.21";`)).toEqual(["lodash null"]);
  });

  it("reads the constant a minified build names and assigns to VERSION", () => {
    const text = `${LODASH_LICENSE};(function(){var vn="4.17.21";function Z(){}Z.VERSION=vn;}).call(this);`;
    expect(at(text)).toEqual([
      {
        library: "lodash",
        name: "Lodash",
        version: "4.17.21",
        evidence: { how: "version-string", matched: "4.17.21" },
      },
    ]);
  });

  it("reads lodash.js's own var VERSION and assignment", () => {
    const text =
      "/**\n * @license\n * Lodash <https://lodash.com/>\n */\n;(function(){var VERSION = '4.17.15';lodash.VERSION = VERSION;}.call(this));";
    expect(versions(text)).toEqual(["lodash 4.17.15"]);
  });

  it("reads a custom build's banner version", () => {
    expect(
      versions("/**\n * @license\n * lodash 4.17.21 (Custom Build) <https://lodash.com/>\n */"),
    ).toEqual(["lodash 4.17.21"]);
  });

  it("is could-not-check, not a version, when neither shape is there", () => {
    expect(at(LODASH_LICENSE)).toEqual([
      { library: "lodash", name: "Lodash", version: null, evidence: { how: "name", matched: "" } },
    ]);
  });
});

describe("detect: Moment is read from its banner only", () => {
  it("does not take a locale file's version-looking assignment", () => {
    const locale =
      '//! moment.js locale configuration\n//! locale : French [fr]\nx.version="2.1.0";';
    expect(at(locale)).toEqual([]);
  });

  it("does not take a version assignment beside a bare Moment mention", () => {
    expect(at('//! moment.js\nhooks.version="2.1.0";')[0]).toMatchObject({
      library: "moment",
      version: null,
    });
  });

  it("still reads the real banner", () => {
    expect(versions("//! moment.js\n//! version : 2.29.4\n//! authors : Tim Wood\n")).toEqual([
      "moment 2.29.4",
    ]);
  });
});

describe("detect: jQuery, jQuery UI and AngularJS code shapes are whole shapes", () => {
  it("does not take a config object with a jquery key", () => {
    expect(at('var cfg={jquery:"1.2.3"};')).toEqual([]);
    expect(at('var v={full:"1.2.3",major:1};')).toEqual([]);
    expect(at('$.extend($.ui,{version:"1.2.3"});')).toEqual([]);
  });

  it("reads the real shapes", () => {
    expect(
      versions('m.fn=m.prototype={jquery:"1.12.4",constructor:m,selector:"",length:0}'),
    ).toEqual(["jquery 1.12.4"]);
    expect(versions('a.extend(a.ui,{version:"1.12.1",keyCode:{BACKSPACE:8}})')).toEqual([
      "jquery-ui 1.12.1",
    ]);
    expect(
      versions('version:{full:"1.8.2",major:1,minor:8,dot:2,codeName:"meteoric-mining"}'),
    ).toEqual(["angularjs 1.8.2"]);
  });
});

describe("detect: only a file name gives a version from an address", () => {
  it("does not read a folder that happens to be named like a library", () => {
    expect(detect("", "https://shop.example/js/jquery/1.2/slider.js")).toEqual([]);
    expect(detect("", "https://shop.example/js/bootstrap@5.3.0/theme.js")).toEqual([]);
    expect(detect("", "https://shop.example/vendor/lodash/4.17.0/other-file.js")).toEqual([]);
  });

  it("reads a version folder only when the file is the library's own", () => {
    expect(detect("", "https://shop.example/vendor/jquery/1.12.4/jquery.min.js")[0]).toMatchObject({
      version: "1.12.4",
    });
    expect(
      detect("", "https://cdn.example/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js")[0],
    ).toMatchObject({
      version: "5.3.0",
    });
  });

  it("never reads a version from a query string", () => {
    expect(detect("", "https://shop.example/js/jquery.min.js?ver=3.5.1")[0]).toMatchObject({
      version: null,
    });
  });
});

describe("detect: a version is read whole or not at all", () => {
  it.each([
    "/*! jQuery JavaScript Library v1.12345\n */",
    "/*! jQuery JavaScript Library v1.9.1.2\n */",
    "//! moment.js\n//! version : 2.29.4.1\n",
    "/**\n * @license AngularJS v1.5.8.9\n */",
  ])("%s is rejected, not truncated", (text) => {
    expect(at(text).filter((d) => d.version !== null)).toEqual([]);
  });

  it("rejects an address version that has a fourth number", () => {
    expect(
      detect("", "https://x.test/jquery-1.9.1.2.min.js").filter((d) => d.version !== null),
    ).toEqual([]);
  });

  it("still reads two numbers, three numbers and a pre-release", () => {
    expect(versions("/**\n * @license AngularJS v1.5\n */")).toEqual(["angularjs 1.5"]);
    expect(versions("/**\n * @license AngularJS v1.5.8\n */")).toEqual(["angularjs 1.5.8"]);
    expect(versions("/**\n * @license AngularJS v1.7.0-rc.2\n */")).toEqual([
      "angularjs 1.7.0-rc.2",
    ]);
  });
});
