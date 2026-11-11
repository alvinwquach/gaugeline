import type { LibraryId } from "./advisories.js";

/**
 * The one table of how each library is recognised in a served file. A rule is a regular expression with the
 * version as its first group. Every expression is bounded (no nested or open-ended repeats over text a site
 * controls), so a hostile file cannot make a read slow. The patterns are the shapes the libraries' own build
 * tools leave behind: a banner comment, a version constant, a conventional file name.
 */

/** A version: two or three numbers, and a pre-release word of the kinds the libraries publish. */
const VER = String.raw`(\d{1,3}\.\d{1,3}(?:\.\d{1,4})?(?:-(?:alpha|beta|rc|pre)\.?\d{0,3})?)`;

/** Where in a file a rule looks; the first rule that finds a version wins. */
export interface BodyRule {
  how: "banner" | "version-string";
  re: RegExp;
  /** The rule counts only in a file that also matches this: a bare VERSION constant means nothing alone. */
  requires?: RegExp;
}

export interface Fingerprint {
  id: LibraryId;
  /** The names the library goes by in a file name or a path (a regular expression, no groups that capture). */
  names: string;
  /** Rules that read a version from the file's text, tried in order. */
  body: BodyRule[];
  /** Text that says the file is this library when no version is written. */
  named?: RegExp;
}

/** A banner opens a block comment: `/*` or `/*!`, then spaces, line breaks and the stars of a comment's edge. */
const OPEN = String.raw`\/\*!?[\s*]{0,40}`;

export const FINGERPRINTS: readonly Fingerprint[] = Object.freeze([
  {
    id: "jquery",
    names: "jquery",
    body: [
      { how: "banner", re: new RegExp(`${OPEN}jQuery(?: JavaScript Library)? v${VER}`) },
      { how: "version-string", re: new RegExp(`\\bjquery\\s{0,3}:\\s{0,3}["']${VER}["']`) },
      { how: "version-string", re: new RegExp(`\\.fn\\.jquery\\s{0,3}=\\s{0,3}["']${VER}["']`) },
    ],
  },
  {
    id: "jquery-ui",
    names: "jquery-ui|jqueryui|jquery\\.ui",
    body: [
      { how: "banner", re: new RegExp(`${OPEN}jQuery UI(?: Core)?(?: - v| v| )${VER}`) },
      {
        how: "version-string",
        re: new RegExp(`\\.ui\\s{0,3},\\s{0,3}\\{\\s{0,3}version\\s{0,3}:\\s{0,3}["']${VER}["']`),
      },
    ],
  },
  {
    id: "lodash",
    names: "lodash",
    body: [
      {
        how: "version-string",
        re: new RegExp(`\\bVERSION\\s{0,3}=\\s{0,3}["']([0-4]\\.\\d{1,3}\\.\\d{1,4})["']`),
        requires: /lodash\.com\/license|<https?:\/\/lodash\.com\/>|@license\s+Lodash\b/,
      },
    ],
    named: /lodash\.com\/license|<https?:\/\/lodash\.com\/>|@license\s+Lodash\b/,
  },
  {
    id: "moment",
    names: "moment|moment-with-locales",
    body: [
      {
        how: "banner",
        re: new RegExp(
          `\\/\\/!\\s{0,4}moment\\.js[\\s\\S]{0,40}?\\/\\/!\\s{0,4}version\\s{0,4}:\\s{0,4}${VER}`,
        ),
      },
      {
        how: "version-string",
        re: new RegExp(`\\.version\\s{0,3}=\\s{0,3}["'](2\\.\\d{1,3}\\.\\d{1,3})["']`),
        requires: /momentjs\.com|\/\/!\s{0,4}moment\.js/,
      },
    ],
    named: /momentjs\.com|\/\/!\s{0,4}moment\.js/,
  },
  {
    id: "bootstrap",
    names: "bootstrap|twitter-bootstrap",
    body: [{ how: "banner", re: new RegExp(`\\bBootstrap(?:: [a-z-]{1,20}\\.js)? v${VER}`) }],
  },
  {
    id: "angularjs",
    names: "angular|angularjs",
    body: [
      { how: "banner", re: new RegExp(`@license\\s{1,4}AngularJS\\s{1,4}v${VER}`) },
      {
        how: "version-string",
        re: new RegExp(
          `\\bfull\\s{0,3}:\\s{0,3}["'](1\\.\\d{1,2}\\.\\d{1,3}(?:-[A-Za-z0-9.]{1,12})?)["']\\s{0,3},\\s{0,3}major\\s{0,3}:\\s{0,3}1\\b`,
        ),
      },
    ],
  },
]);

/** The words that may follow a version in a file name: jquery-3.5.1.slim.min.js, jquery-ui-1.12.1.custom.min.js. */
const SUFFIX = String.raw`(?:\.(?:min|slim|bundle|custom|all|full|pkgd))*`;

/** The version in an address (lower case, no query or fragment): the file name, a path folder, or an npm @version. */
const URL_VER = String.raw`(\d{1,3}\.\d{1,3}(?:\.\d{1,4})?(?:-(?:alpha|beta|rc|pre)\.?\d{0,3})?)`;

export interface UrlRules {
  /** Rules that read a version from an address, tried in order. */
  versioned: RegExp[];
  /** The bare file name of the library (jquery.min.js): the library, no version. */
  bare: RegExp;
}

/** The address rules of one library, built from its names. */
export function urlRules(f: Fingerprint): UrlRules {
  const n = `(?:${f.names})`;
  return {
    versioned: [
      new RegExp(`(?:^|/)${n}[-.]${URL_VER}${SUFFIX}\\.js$`),
      new RegExp(`(?:^|/)${n}(?:\\.js)?/${URL_VER}(?:/|$)`),
      new RegExp(`(?:^|/)${n}(?:\\.js)?@${URL_VER}(?:/|$)`),
    ],
    bare: new RegExp(`(?:^|/)${n}${SUFFIX}\\.js$`),
  };
}
