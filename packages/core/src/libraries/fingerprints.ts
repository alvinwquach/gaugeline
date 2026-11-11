import type { LibraryId } from "./advisories.js";

/**
 * The one table of how each library is recognised in a served file. A version comes only from a whole shape: a
 * real banner (the comment a build tool writes, with its own tail), a code shape only the library has, or the
 * library's own file name. A sentence in a comment ("Requires Bootstrap v4.0+"), a neighbour's constant or a folder
 * that happens to be named like a library is never a version. The shapes are written from what the libraries'
 * build tools produce, as remembered: they are not yet compared with real files (the tests use invented
 * stand-ins that carry only the shape), and a file that matches nothing is could-not-check, never guessed.
 *
 * Every expression is bounded (no nested or open-ended repeats over text a site controls), so a hostile file
 * cannot make a read slow.
 */

/**
 * A version, read whole: two or three numbers, and a pre-release word of the kinds the libraries publish. It must
 * not run on into another digit or dotted number ("1.9.1.2", "1.12345"), which is rejected, not cut short.
 */
const VER = String.raw`(\d{1,3}\.\d{1,3}(?:\.\d{1,4})?(?:-(?:alpha|beta|rc|pre)(?:\.?\d{1,3})?)?)(?!\d|\.\d)`;

/** A banner's start: the opening of a block comment, or a comment line that starts with a star. */
const LEAD = String.raw`(?:\/\*!?[\s*]{0,40}|\n[ \t]{0,8}\*[ \t]{1,4})`;

/** Where in a file a rule looks; the first rule that finds a version wins. */
export interface BodyRule {
  how: "banner" | "version-string";
  /** The version, or undefined when the file does not carry the shape. */
  find: (text: string) => string | undefined;
}

export interface Fingerprint {
  id: LibraryId;
  /** The names the library goes by in a file name (a regular expression, no groups that capture). */
  names: string;
  /** Rules that read a version from the file's text, tried in order. */
  body: BodyRule[];
  /** Text that says the file is this library when no version is written. */
  named?: RegExp;
}

/** A rule that is one regular expression whose first group is the version. */
const rx = (how: BodyRule["how"], pattern: string): BodyRule => {
  const re = new RegExp(pattern);
  return { how, find: (text) => re.exec(text)?.[1] };
};

/** Text only a Lodash file carries: its license line. */
const LODASH_MARK = /lodash\.com\/license|<https?:\/\/lodash\.com\/>|@license\s+Lodash\b/;

/** The most `.VERSION=name` assignments looked at in one file. */
const LODASH_ASSIGNMENTS = 10;

/**
 * Lodash names its version in a constant and assigns that to `VERSION` (`lodash.VERSION = VERSION` in lodash.js; a
 * minified build keeps the constant under a short name). Only where a Lodash license line is also in the file, and
 * only a constant that is assigned to `.VERSION` by name: `Backbone.VERSION='1.1.2'` is a literal, not this shape,
 * and a neighbour that follows the same shape (Underscore, version 1) is not Lodash 2 to 4.
 */
function lodashConstant(text: string): string | undefined {
  if (!LODASH_MARK.test(text)) return undefined;
  const assigned = /\.VERSION\s{0,3}=\s{0,3}([A-Za-z_$][\w$]{0,11})(?![\w$(])/g;
  let seen = 0;
  for (let m = assigned.exec(text); m && seen < LODASH_ASSIGNMENTS; m = assigned.exec(text)) {
    seen++;
    const name = (m[1] ?? "").replace(/\$/g, "\\$");
    const v = new RegExp(
      `(?:^|[^\\w$.])${name}\\s{0,3}=\\s{0,3}["']([2-4]\\.\\d{1,3}\\.\\d{1,4})["'](?!\\d)`,
    ).exec(text)?.[1];
    if (v !== undefined) return v;
  }
  return undefined;
}

export const FINGERPRINTS: readonly Fingerprint[] = Object.freeze([
  {
    id: "jquery",
    names: "jquery",
    body: [
      rx("banner", `${LEAD}jQuery JavaScript Library v${VER}`),
      rx("banner", `${LEAD}jQuery v${VER}[^\\n]{0,400}?jquery\\.org\\/license`),
      rx(
        "version-string",
        `\\bjquery\\s{0,3}:\\s{0,3}["']${VER}["']\\s{0,3},\\s{0,3}constructor\\s{0,3}:`,
      ),
    ],
  },
  {
    id: "jquery-ui",
    names: "jquery-ui|jqueryui|jquery\\.ui",
    body: [
      rx("banner", `${LEAD}jQuery UI - v${VER} - \\d{4}-\\d{2}-\\d{2}`),
      rx(
        "banner",
        `${LEAD}jQuery UI(?: [A-Za-z]{1,20}){0,3} ${VER}[ \\t]{0,3}\\r?\\n[ \\t*]{0,10}https?:\\/\\/jqueryui\\.com`,
      ),
      rx(
        "version-string",
        `\\.ui\\s{0,3},\\s{0,3}\\{\\s{0,3}version\\s{0,3}:\\s{0,3}["']${VER}["']\\s{0,3},\\s{0,3}keyCode`,
      ),
    ],
  },
  {
    id: "lodash",
    names: "lodash",
    body: [
      rx("banner", `\\blodash\\s{1,3}v?${VER} \\(Custom Build\\)`),
      { how: "version-string", find: lodashConstant },
    ],
    named: LODASH_MARK,
  },
  {
    id: "moment",
    names: "moment|moment-with-locales",
    body: [
      rx(
        "banner",
        `\\/\\/!\\s{0,4}moment\\.js[ \\t]{0,3}\\r?\\n[\\s\\S]{0,40}?\\/\\/!\\s{0,4}version\\s{0,4}:\\s{0,4}${VER}`,
      ),
    ],
    // "//! moment.js" alone on its line: a locale file's "//! moment.js locale configuration" is not it.
    named: /\/\/!\s{0,4}moment\.js[ \t]{0,3}\r?\n/,
  },
  {
    id: "bootstrap",
    names: "bootstrap|twitter-bootstrap",
    body: [
      rx("banner", `${LEAD}Bootstrap v${VER} \\((?:https?:)?\\/\\/(?:www\\.)?getbootstrap\\.com`),
      rx("banner", `${LEAD}Bootstrap: [a-z-]{1,20}\\.js v${VER}[ \\t]{0,3}(?:\\r?\\n|\\*\\/)`),
    ],
  },
  {
    id: "angularjs",
    names: "angular|angularjs",
    body: [
      rx("banner", `${LEAD}@license\\s{1,4}AngularJS\\s{1,4}v${VER}`),
      rx(
        "version-string",
        `\\bfull\\s{0,3}:\\s{0,3}["']${VER}["']\\s{0,3},\\s{0,3}major\\s{0,3}:\\s{0,3}1\\s{0,3},\\s{0,3}minor\\s{0,3}:\\s{0,3}\\d{1,3}\\s{0,3},\\s{0,3}dot\\s{0,3}:\\s{0,3}\\d{1,3}\\s{0,3},\\s{0,3}codeName\\s{0,3}:`,
      ),
    ],
  },
]);

/** The words that may follow a version in a file name: jquery-3.5.1.slim.min.js, jquery-ui-1.12.1.custom.min.js. */
const SUFFIX = String.raw`(?:\.(?:min|slim|bundle|custom|all|full|pkgd))*`;

/** The version in an address (lower case, no query or fragment). Read whole, like the version in a file. */
const URL_VER = VER;

export interface UrlRules {
  /** The version in the file's own name: jquery-3.5.1.min.js. */
  file: RegExp;
  /** The bare file name of the library (jquery.min.js): the library, no version. */
  bare: RegExp;
  /**
   * A version in a folder of the path (`/jquery/1.12.4/`, or an npm `lodash@4.17.21/`). Read only when the file
   * itself is the library's (`bare`): a folder named like a library that holds other files is not the library.
   */
  folders: RegExp[];
}

/** The address rules of one library, built from its names. */
export function urlRules(f: Fingerprint): UrlRules {
  const n = `(?:${f.names})`;
  return {
    file: new RegExp(`(?:^|/)${n}[-.]${URL_VER}${SUFFIX}\\.js$`),
    bare: new RegExp(`(?:^|/)${n}${SUFFIX}\\.js$`),
    folders: [
      new RegExp(`(?:^|/)${n}(?:\\.js)?/${URL_VER}(?:/|$)`),
      new RegExp(`(?:^|/)${n}(?:\\.js)?@${URL_VER}(?:/|$)`),
    ],
  };
}
