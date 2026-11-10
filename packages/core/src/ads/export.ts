import { ConfigError } from "../errors.js";
import { normaliseHeader, parseCsv } from "../plan/columns.js";
import { formatMoney, toMinor } from "../products/money.js";

/**
 * Reading an ads export (Meta Ads Manager or Google Ads) and grouping its ads by the page they send
 * people to. Nothing here makes a request: a destination is a key and a list of ads.
 *
 * Spend is a whole number of minor units (cents, yen), read from the text of the cell with toMinor
 * and never through a float, so a campaign's total is exact and sorts the same way every time.
 */

/** One ad. `spend` is an integer in minor units; `currency` is an upper-case ISO 4217 code, when the file names one. */
export interface AdRow {
  name?: string;
  link: string;
  spend: number;
  currency?: string;
}

/** One landing page, and every ad that sends people to it. */
export interface Destination {
  /** The destination key (see adDestinationKey): the same string the Map is keyed by. */
  url: string;
  ads: AdRow[];
  /** Spend in the file's main currency (the one most of its ads use), in minor units. Never a sum across currencies. */
  spend: number;
  /** Each ad's own campaign tags (utm_*, gclid, fbclid), in step with `ads`: `tags[i]` belongs to `ads[i]`. {} for an ad with none. */
  tags: Record<string, string>[];
  /** The spend of this page in each currency, by upper-case code ("" when the file names none), main currency first. */
  spendByCurrency: Map<string, number>;
}

export interface AdsExport {
  rows: AdRow[];
  /** The two columns that were read, as written in the file. */
  columns: { link: string; spend: string };
  warnings: string[];
}

// Candidate headers, after normaliseHeader (lower case, punctuation to single spaces). Earlier wins.
const LINK_HEADERS = [
  "link",
  "website url",
  "final url",
  "final urls",
  "destination",
  "destination url",
  "landing page url",
  "landing page",
  "link url",
  "url",
] as const;
const NAME_HEADERS = ["ad name", "ad", "name", "creative name"] as const;
const CURRENCY_HEADERS = ["currency", "currency code"] as const;
const SPEND_BASES = ["amount spent", "spend", "cost"] as const;
/** "amount spent", "cost", and Meta's "Amount spent (USD)", which normalises to "amount spent usd". */
const SPEND_HEADER = /^(amount spent|spend|cost)(?: ([a-z]{3}))?$/;

/** A row that sums the ones above it: Google's "Total: Account", Meta's "Results from 12 ads". */
const TOTALS = /^(total\s*(:|$)|results from\b)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const NOT_WEB = /^(mailto|tel|sms|javascript|data|file|blob):/i;
const BLANK_LINK = /^(--+|-|n\/?a)?$/i;

const HEADER_SCAN = 30;

function headersOf(cells: string[]): string[] {
  return cells.map((c) => c.trim()).filter((c) => c !== "");
}

/** The headers to name when the file cannot be used: the widest line among the first few (the table, not a title). */
function headersFound(records: { cells: string[] }[]): string[] {
  let best: string[] = [];
  for (const r of records.slice(0, HEADER_SCAN)) {
    const h = headersOf(r.cells);
    if (h.length > best.length) best = h;
  }
  return best;
}

function unusable(what: string, wanted: string, found: string[]): ConfigError {
  const tabs =
    found.length === 1 && (found[0] ?? "").includes("\t")
      ? " It looks tab-separated: save it again as a comma-separated CSV."
      : "";
  return new ConfigError(
    `The export has no ${what} column. Gaugeline looks for a column called ${wanted}. Headers found: ${found.length > 0 ? found.join(", ") : "none"}.${tabs}`,
  );
}

const exponents = new Map<string, string>();
/**
 * toMinor knows four currencies by name. The app formats spend with Intl, which knows every
 * currency's places, so the amount is read with the places Intl gives: a currency of 0 places is
 * read like jpy, of 3 like bhd, and the rest with two. A code Intl refuses is read with two.
 */
function readingCurrency(code: string | undefined): string | undefined {
  if (!code) return undefined;
  let found = exponents.get(code);
  if (found === undefined) {
    let places = 2;
    try {
      places =
        new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      places = 2;
    }
    found = places === 0 ? "jpy" : places === 3 ? "bhd" : "usd";
    exponents.set(code, found);
  }
  return found;
}

type SpendRead = { amount: number; flag?: "ambiguous" | "unreadable" };

/**
 * A spend cell as minor units. Symbols, letters and spaces around the digits are dropped ("$1,204.50",
 * "US$ 0.99", "1 204,50"). A blank, "--" or "n/a" is 0. When both "," and "." appear the last one is the
 * decimal mark; "1.204,50" is read as 1204.50 and flagged, as is a lone "," that is not a thousands group
 * ("12,50"). Text that is not an amount, a negative, or more places than the currency has is 0 and flagged.
 */
function readSpend(cell: string, currency: string | undefined): SpendRead {
  const text = cell.trim();
  if (/^(--+|-|n\/?a)?$/i.test(text)) return { amount: 0 };
  const digits = text.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(digits) || digits.includes("-")) return { amount: 0, flag: "unreadable" };
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  let plain: string;
  let ambiguous = false;
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) {
      plain = digits.replace(/\./g, "").replace(",", ".");
      ambiguous = true;
    } else plain = digits.replace(/,/g, "");
  } else if (lastComma >= 0) {
    if (/^\d{1,3}(,\d{3})+$/.test(digits)) plain = digits.replace(/,/g, "");
    else {
      plain = digits.replace(",", ".");
      ambiguous = true;
    }
  } else if (lastDot >= 0 && digits.indexOf(".") !== lastDot) {
    plain = digits.replace(/\./g, "");
    ambiguous = true;
  } else plain = digits;
  if (plain.startsWith(".")) plain = `0${plain}`;
  try {
    const amount = toMinor(plain, readingCurrency(currency));
    return ambiguous ? { amount, flag: "ambiguous" } : { amount };
  } catch {
    return { amount: 0, flag: "unreadable" };
  }
}

/** An address for a message: the query (a campaign, maybe a click id) is left out. */
const shown = (link: string): string => `"${link.split(/[?#]/)[0] ?? link}"`;

interface Note {
  line: number;
  text: string;
}
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * Read an ads export: the header is the first line (within the first thirty) with a link column, so
 * a title or date range above the table is skipped. Totals rows are skipped. A row with no link, or
 * a link that is not a web address, is skipped and counted in the warnings. A file with no link
 * column, or no amount-spent column, is a ConfigError that lists the headers it found.
 */
export function readAdsExport(csvText: string): AdsExport {
  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  const records = parseCsv(text);
  const normalised = (cells: string[]) => cells.map((c) => normaliseHeader(c));
  const headerAt = records
    .slice(0, HEADER_SCAN)
    .findIndex((r) =>
      normalised(r.cells).some((h) => (LINK_HEADERS as readonly string[]).includes(h)),
    );
  if (headerAt < 0)
    throw unusable("link", "Link, Website URL, Final URL or Destination", headersFound(records));
  const header = (records[headerAt]?.cells ?? []).map((h) => h.trim());
  const names = normalised(header);
  const warnings: string[] = [];

  const linkColumns = names
    .map((n, i) => ({ i, rank: (LINK_HEADERS as readonly string[]).indexOf(n) }))
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  const linkAt = linkColumns[0]?.i ?? 0;
  if (linkColumns.length > 1)
    warnings.push(
      `Columns ${linkColumns.map((c) => `"${header[c.i] ?? ""}"`).join(" and ")} all look like the link column; using "${header[linkAt] ?? ""}".`,
    );

  const spendColumns = names
    .map((n, i) => {
      const m = SPEND_HEADER.exec(n);
      return {
        i,
        rank: m ? (SPEND_BASES as readonly string[]).indexOf(m[1] ?? "") : -1,
        code: m?.[2]?.toUpperCase(),
      };
    })
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  const spend = spendColumns[0];
  if (!spend) throw unusable("amount-spent", "Amount spent, Spend or Cost", headersOf(header));
  if (spendColumns.length > 1)
    warnings.push(
      `Columns ${spendColumns.map((c) => `"${header[c.i] ?? ""}"`).join(" and ")} all look like the amount-spent column; using "${header[spend.i] ?? ""}".`,
    );

  const first = (candidates: readonly string[]): number => {
    for (const c of candidates) {
      const i = names.indexOf(c);
      if (i >= 0) return i;
    }
    return -1;
  };
  const nameAt = first(NAME_HEADERS);
  const currencyAt = first(CURRENCY_HEADERS);

  const rows: AdRow[] = [];
  const noLink: Note[] = [];
  const notWeb: Note[] = [];
  const noScheme: Note[] = [];
  const ambiguous: Note[] = [];
  const unreadable: Note[] = [];

  for (const r of records.slice(headerAt + 1)) {
    const cells = r.cells.map((c) => c.trim());
    if (cells.every((c) => c === "")) continue;
    if (cells.slice(0, 3).some((c) => TOTALS.test(c))) continue;
    const cell = cells[linkAt] ?? "";
    if (BLANK_LINK.test(cell)) {
      noLink.push({ line: r.line, text: "" });
      continue;
    }
    let link = cell;
    if (!SCHEME.test(link)) {
      if (NOT_WEB.test(link)) {
        notWeb.push({ line: r.line, text: link });
        continue;
      }
      link = link.startsWith("//") ? `https:${link}` : `https://${link}`;
      noScheme.push({ line: r.line, text: cell });
    }
    let host = "";
    try {
      const u = new URL(link);
      if (u.protocol === "http:" || u.protocol === "https:") host = u.hostname;
    } catch {
      host = "";
    }
    if (!host.includes(".") && !host.includes(":")) {
      // Not a web address after all: take back the scheme it was given.
      if (noScheme[noScheme.length - 1]?.line === r.line) noScheme.pop();
      notWeb.push({ line: r.line, text: cell });
      continue;
    }

    const currencyCell = currencyAt >= 0 ? (cells[currencyAt] ?? "") : "";
    const currency = /^[a-z]{3}$/i.test(currencyCell) ? currencyCell.toUpperCase() : spend.code;
    const rawSpend = cells[spend.i] ?? "";
    const read = readSpend(rawSpend, currency);
    if (read.flag === "ambiguous") ambiguous.push({ line: r.line, text: rawSpend });
    if (read.flag === "unreadable") unreadable.push({ line: r.line, text: rawSpend });
    const name = nameAt >= 0 ? (cells[nameAt] ?? "") : "";
    rows.push({
      ...(name !== "" ? { name } : {}),
      link,
      spend: read.amount,
      ...(currency ? { currency } : {}),
    });
  }

  if (noLink.length > 0)
    warnings.push(
      `${noLink.length} ${plural(noLink.length, "row had", "rows had")} no link and ${plural(noLink.length, "was", "were")} skipped (the first is line ${noLink[0]?.line ?? 0}).`,
    );
  if (notWeb.length > 0)
    warnings.push(
      `${notWeb.length} ${plural(notWeb.length, "link was", "links were")} not ${plural(notWeb.length, "a web address", "web addresses")} and ${plural(notWeb.length, "was", "were")} skipped (the first is line ${notWeb[0]?.line ?? 0}).`,
    );
  if (noScheme.length > 0)
    warnings.push(
      `${noScheme.length} ${plural(noScheme.length, "link had", "links had")} no http:// or https:// and ${plural(noScheme.length, "was", "were")} read as https:// (the first is ${shown(noScheme[0]?.text ?? "")} on line ${noScheme[0]?.line ?? 0}).`,
    );
  if (ambiguous.length > 0)
    warnings.push(
      `${ambiguous.length} spend ${plural(ambiguous.length, "amount is", "amounts are")} ambiguous, with a comma where a decimal point would be (for example "${ambiguous[0]?.text ?? ""}" on line ${ambiguous[0]?.line ?? 0}), and ${plural(ambiguous.length, "was", "were")} read with the comma as the decimal mark. Check ${plural(ambiguous.length, "it", "them")}.`,
    );
  if (unreadable.length > 0)
    warnings.push(
      `${unreadable.length} spend ${plural(unreadable.length, "amount", "amounts")} could not be read (for example "${unreadable[0]?.text ?? ""}" on line ${unreadable[0]?.line ?? 0}) and ${plural(unreadable.length, "counts", "count")} as 0.`,
    );
  if (rows.length === 0)
    warnings.push("The export has no ads with a link, so there is nothing to group.");

  return {
    rows,
    columns: { link: header[linkAt] ?? "", spend: header[spend.i] ?? "" },
    warnings,
  };
}

/** utm_ anything, gclid and fbclid: the tags a campaign adds to a link. */
const CAMPAIGN_KEY = /^(utm_.*|gclid|fbclid)$/i;

/**
 * The destination key of a link, and the campaign tags taken out of it. The key is the link with
 * every utm_*, gclid and fbclid removed, the fragment removed, any user name and password removed, the
 * host lower-cased (and a default port dropped, as the URL parser does) and the remaining query sorted by
 * key and then value. The path is left exactly as written: /menu and /menu/ are two destinations,
 * because a server may treat them as two pages. The tags keep the first value of each key, decoded,
 * under the key in lower case.
 */
export function adDestinationKey(link: string): { key: string; tags: Record<string, string> } {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    // A link with a scheme the parser refuses stays as it is; one without is tried as https.
    if (SCHEME.test(link)) return { key: link.trim(), tags: {} };
    try {
      u = new URL(`https://${link}`);
    } catch {
      return { key: link.trim(), tags: {} };
    }
  }
  const tags: Record<string, string> = {};
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (CAMPAIGN_KEY.test(k)) tags[k.toLowerCase()] ??= v;
    else kept.push([k, v]);
  }
  kept.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  const query = new URLSearchParams(kept).toString();
  return { key: `${u.protocol}//${u.host}${u.pathname}${query ? `?${query}` : ""}`, tags };
}

/** The currency most ads use (ties go to the code that sorts first); "" when no ad names one. */
function mainCurrency(rows: readonly AdRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.currency ?? "", (counts.get(r.currency ?? "") ?? 0) + 1);
  let best = "";
  let most = -1;
  for (const [code, n] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n > most) {
      best = code;
      most = n;
    }
  }
  return best;
}

/**
 * Group ads by destination: a Map keyed by adDestinationKey, in the order the destinations first
 * appear. Each destination holds its ads, their tags and its spend. Spend is added per currency and
 * never across them: `spend` is the main currency's, and `spendByCurrency` has every one.
 */
export function groupByDestination(rows: readonly AdRow[]): Map<string, Destination> {
  const main = mainCurrency(rows);
  const groups = new Map<string, Destination>();
  for (const row of rows) {
    const { key, tags } = adDestinationKey(row.link);
    let d = groups.get(key);
    if (!d) {
      d = { url: key, ads: [], spend: 0, tags: [], spendByCurrency: new Map() };
      groups.set(key, d);
    }
    d.ads.push(row);
    d.tags.push(tags);
    const code = row.currency ?? "";
    d.spendByCurrency.set(code, (d.spendByCurrency.get(code) ?? 0) + row.spend);
  }
  for (const d of groups.values()) {
    d.spend = d.spendByCurrency.get(main) ?? 0;
    // Main currency first, then the others by code.
    d.spendByCurrency = new Map(
      [...d.spendByCurrency].sort((a, b) =>
        a[0] === main ? -1 : b[0] === main ? 1 : a[0] < b[0] ? -1 : 1,
      ),
    );
    if (!Number.isSafeInteger(d.spend))
      throw new RangeError("The spend on one landing page is too large to add up exactly.");
  }
  return groups;
}

/** Highest spend first, then by address, comparing code units so the order never depends on a locale. */
function bySpend(a: { url: string; spend: number }, b: { url: string; spend: number }): number {
  return b.spend - a.spend || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

export interface CurrencySpend {
  /** An upper-case ISO 4217 code, or null when the export names none. */
  currency: string | null;
  destinations: { url: string; ads: number; spend: number }[];
}

/**
 * The spend of each currency on its own: one table per currency, the main one first, each sorted by
 * spend (highest first) and then by address. `ads` counts the ads that spent in that currency.
 */
export function spendByCurrency(groups: ReadonlyMap<string, Destination>): CurrencySpend[] {
  const tables = new Map<string, { url: string; ads: number; spend: number }[]>();
  const adsIn = new Map<string, number>();
  for (const d of groups.values()) {
    for (const [code, spend] of d.spendByCurrency) {
      const ads = d.ads.filter((a) => (a.currency ?? "") === code).length;
      adsIn.set(code, (adsIn.get(code) ?? 0) + ads);
      const list = tables.get(code) ?? [];
      list.push({ url: d.url, ads, spend });
      tables.set(code, list);
    }
  }
  // The currency most ads use first (the same one groupByDestination calls main), then by code.
  const order = [...tables.keys()].sort(
    (a, b) => (adsIn.get(b) ?? 0) - (adsIn.get(a) ?? 0) || (a < b ? -1 : 1),
  );
  return order.map((code) => ({
    currency: code === "" ? null : code,
    destinations: (tables.get(code) ?? []).sort(bySpend),
  }));
}

/**
 * One line per destination for the terminal: address, number of ads, spend. Sorted by spend, highest
 * first, then by address. A page that took money in more than one currency lists each, joined with
 * " + ", and they are never added.
 */
export function formatDestinationLines(groups: ReadonlyMap<string, Destination>): string[] {
  const list = [...groups.values()].sort(bySpend);
  const ads = list.map((d) => `${d.ads.length} ${d.ads.length === 1 ? "ad" : "ads"}`);
  const money = list.map((d) =>
    [...d.spendByCurrency]
      .map(([code, amount]) => formatMoney({ amount, currency: code }))
      .join(" + "),
  );
  const wUrl = Math.max(0, ...list.map((d) => d.url.length));
  const wAds = Math.max(0, ...ads.map((a) => a.length));
  const wMoney = Math.max(0, ...money.map((m) => m.length));
  return list.map(
    (d, i) =>
      `${d.url.padEnd(wUrl)}  ${(ads[i] ?? "").padStart(wAds)}  ${(money[i] ?? "").padStart(wMoney)}`,
  );
}
