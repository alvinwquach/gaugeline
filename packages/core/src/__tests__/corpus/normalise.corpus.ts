/**
 * Append only. A later phase adds cases at the end; it never edits or deletes one.
 *
 * Each row's name says what it proves. A behaviour change shows up as a failing old row.
 */
import type { AddressComparison, CompareOptions } from "../../normalise.js";

/** [name, input, expected] — input may be "relative|base" to resolve against a base. */
export const URL_CASES: Array<[string, string, string]> = [
  ["uppercase scheme is lowercased", "HTTPS://example.com/", "https://example.com/"],
  ["uppercase host is lowercased", "https://EXAMPLE.Com/a", "https://example.com/a"],
  [":443 on https is dropped", "https://example.com:443/a", "https://example.com/a"],
  [":80 on http is dropped", "http://example.com:80/a", "http://example.com/a"],
  [":8080 is kept", "http://example.com:8080/a", "http://example.com:8080/a"],
  [":443 on http is kept", "http://example.com:443/", "http://example.com:443/"],
  ["fragment is dropped", "https://example.com/a#section", "https://example.com/a"],
  ["empty fragment is dropped", "https://example.com/a#", "https://example.com/a"],
  ["query order is kept", "https://example.com/?b=2&a=1", "https://example.com/?b=2&a=1"],
  ["query survives fragment removal", "https://example.com/a?x=1#y", "https://example.com/a?x=1"],
  [
    "percent-encoding case is preserved (%2f)",
    "https://example.com/a%2fb",
    "https://example.com/a%2fb",
  ],
  [
    "percent-encoding case is preserved (%2F)",
    "https://example.com/a%2Fb",
    "https://example.com/a%2Fb",
  ],
  ["IDN host becomes punycode", "https://bücher.example/", "https://xn--bcher-kva.example/"],
  ["dot segments are resolved", "https://example.com/a/./b/../c", "https://example.com/a/c"],
  [
    "relative input resolves against a base",
    "../menu|https://example.com/shop/item/",
    "https://example.com/shop/menu",
  ],
  [
    "root-relative input resolves against a base",
    "/about|https://example.com/shop/",
    "https://example.com/about",
  ],
  ["bare origin gains a root slash", "https://example.com", "https://example.com/"],
  ["trailing slash is kept", "https://example.com/a/", "https://example.com/a/"],
  ["no trailing slash stays without one", "https://example.com/a", "https://example.com/a"],
  ["surrounding whitespace is trimmed", "  https://example.com/a\n", "https://example.com/a"],
  [
    "spaces in the path are encoded",
    "https://example.com/new page",
    "https://example.com/new%20page",
  ],
  ["path case is kept", "https://example.com/About", "https://example.com/About"],
];

const same: AddressComparison = { same: true };
const differs = (
  ...differsBy: Extract<AddressComparison, { same: false }>["differsBy"]
): AddressComparison => ({
  same: false,
  differsBy,
});

/** [name, a, b, options, expected] */
export const ADDRESS_CASES: Array<[string, string, string, CompareOptions, AddressComparison]> = [
  ["identical addresses are the same", "https://example.com/a", "https://example.com/a", {}, same],
  [
    "slash vs no slash is the same by default",
    "https://example.com/a/",
    "https://example.com/a",
    {},
    same,
  ],
  [
    "slash vs no slash is distinct on request",
    "https://example.com/a/",
    "https://example.com/a",
    { trailingSlash: "distinct" },
    differs("trailing-slash"),
  ],
  [
    "www is distinct by default",
    "https://www.example.com/",
    "https://example.com/",
    {},
    differs("www"),
  ],
  [
    "www is the same on request",
    "https://www.example.com/",
    "https://example.com/",
    { www: "same" },
    same,
  ],
  [
    "http vs https differs by scheme",
    "http://example.com/",
    "https://example.com/",
    {},
    differs("scheme"),
  ],
  [
    "http vs https differs by scheme even with www same",
    "http://example.com/",
    "https://example.com/",
    { www: "same" },
    differs("scheme"),
  ],
  [
    "/About vs /about reports path-case",
    "https://example.com/About",
    "https://example.com/about",
    {},
    differs("path-case"),
  ],
  [
    "two reasons when two apply (scheme and path)",
    "http://example.com/a",
    "https://example.com/b",
    {},
    differs("scheme", "path"),
  ],
  [
    "different hosts differ by host",
    "https://example.com/",
    "https://example.org/",
    {},
    differs("host"),
  ],
  ["host compares case-insensitively", "https://EXAMPLE.com/a", "https://example.com/a", {}, same],
  [
    "explicit default port is the same",
    "https://example.com:443/a",
    "https://example.com/a",
    {},
    same,
  ],
  [
    "a different port differs by port",
    "https://example.com:8443/a",
    "https://example.com/a",
    {},
    differs("port"),
  ],
  ["fragments never count", "https://example.com/a#x", "https://example.com/a#y", {}, same],
  [
    "a query differs by default",
    "https://example.com/a?utm_source=x",
    "https://example.com/a",
    {},
    differs("query"),
  ],
  [
    "a query is ignored on request",
    "https://example.com/a?utm_source=x",
    "https://example.com/a",
    { query: "ignore" },
    same,
  ],
  [
    "different paths differ by path",
    "https://example.com/menu",
    "https://example.com/hours",
    {},
    differs("path"),
  ],
  [
    "percent-encoding case does not count",
    "https://example.com/a%2fb",
    "https://example.com/a%2Fb",
    {},
    same,
  ],
  [
    "path case and trailing slash together, slash distinct",
    "https://example.com/About/",
    "https://example.com/about",
    { trailingSlash: "distinct" },
    differs("path-case", "trailing-slash"),
  ],
  [
    "a bad address is not the same, by host",
    "not a url",
    "https://example.com/",
    {},
    differs("host"),
  ],
  [
    "www plus a path change lists both",
    "https://www.example.com/a",
    "https://example.com/b",
    {},
    differs("www", "path"),
  ],
  [
    "IDN and punycode hosts are the same",
    "https://bücher.example/",
    "https://xn--bcher-kva.example/",
    {},
    same,
  ],
];

/** [name, a, b, same] — compared with sameText (case-insensitive). */
export const TEXT_CASES: Array<[string, string, string, boolean]> = [
  ["curly vs straight apostrophe are the same", "Lula\u2019s Kitchen", "Lula's Kitchen", true],
  ["curly vs straight double quotes are the same", "\u201CFresh\u201D", '"Fresh"', true],
  ["en dash vs hyphen are the same", "Mon\u2013Fri", "Mon-Fri", true],
  ["em dash vs hyphen are the same", "Open\u2014late", "Open-late", true],
  ["minus sign vs hyphen are the same", "\u22125%", "-5%", true],
  ["non-breaking hyphen vs hyphen are the same", "pop\u2011up", "pop-up", true],
  ["NBSP vs space are the same", "Happy\u00A0hour", "Happy hour", true],
  ["narrow NBSP vs space are the same", "10\u202Fam", "10 am", true],
  ["thin space vs space are the same", "a\u2009b", "a b", true],
  ["double space vs single are the same", "Happy  hour", "Happy hour", true],
  ["trailing space does not count", "Pricing", "Pricing ", true],
  ["leading newline does not count", "\nPricing", "Pricing", true],
  ["different words differ", "Pricing", "Prices", false],
  ["zero-width space inside a word is ignored", "Pri\u200Bcing", "Pricing", true],
  ["zero-width joiner is ignored", "Me\u200Dnu", "Menu", true],
  ["BOM is ignored", "\uFEFFMenu", "Menu", true],
  ["case is ignored by default", "MENU", "menu", true],
  ["composed vs decomposed e-acute are the same", "Café", "Cafe\u0301", true],
  ["Cyrillic a vs Latin a differ", "\u0430pple", "apple", false],
  ["tabs collapse like spaces", "a\tb", "a b", true],
  ["empty and whitespace-only are the same", "", " ", true],
  ["a word vs empty differ", "Menu", "", false],
];
