import type { Fetcher } from "../fetcher.js";
import type { PartialRead } from "./collect.js";
import {
  HUBSPOT_PAGE_KINDS,
  PartRefused,
  liveAddress,
  type HubspotCmsAdapter,
  type HubspotPageKind,
} from "./hubspot-cms.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { bare, type PageAnswer } from "./webflow-read.js";

/** Bounds a HubSpot read keeps to. There are no flags to raise them. */
export const HUBSPOT_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
  /** Different forms asked about in one run (one GET each). */
  forms: 50,
  /** Form embeds read from one page. More are could-not-check, never dropped quietly. */
  formsPerPage: 20,
  /** A page's HTML is scanned up to this many characters. A bigger page is counted as answered and not scanned. */
  htmlChars: 512 * 1024,
  /** A HubDB value longer than this is not looked for on a page. */
  valueChars: 300,
} as const;

/** How the live site answered for one published page. */
export interface HubspotPageRead {
  id: string;
  type: HubspotPageKind;
  slug?: string;
  url: string;
  path: string;
  answer: PageAnswer;
}

/** A HubDB row compared with the page that shows it. Column names only: never a value. */
export interface HubdbRowRead {
  table: string;
  rowId: string;
  /** The page's path, for the words a finding uses. */
  path: string;
  state: "matches" | "differs" | "unread";
  /** The columns whose value is not on the page. */
  columns: string[];
  /** Named columns with a value that were not compared: a date, or a value too short or too long to look for reliably. */
  notCompared: string[];
  reason?: string;
}

/** A form the site's pages embed that HubSpot no longer has. */
export interface DeletedForm {
  formId: string;
  /** The paths of the pages that embed it. */
  paths: string[];
}

/**
 * What the three HubSpot checks need, read once: how the live site answered for each published page of
 * this domain, each HubDB row against its page, and each embedded form against the portal's forms. Ids,
 * slugs, addresses, statuses, column names and counts only: never a title, a text or a value.
 */
export interface HubspotCmsReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: HubspotPageRead[];
  /** Published pages the portal serves on another domain: not this site's, not asked, not counted. */
  otherDomain: number;
  /** Published pages HubSpot gave no usable https address for: not asked. */
  noAddress: number;
  /** Pages whose state is none of PUBLISHED, DRAFT or SCHEDULED: not counted as live, and counted here. */
  statesUnrecognised: number;
  /** Parts of the portal the token may not read, with why: the other parts were still read. */
  unreadable: { part: string; reason: string }[];
  hubdb: HubdbRowRead[];
  /** HubDB tables named in the settings that no published dynamic page on this site shows. */
  hubdbWithoutPage: string[];
  /** Rows of a named table that have no path, so no page of their own. */
  hubdbRowsWithoutPath: number;
  forms: {
    /** Different forms HubSpot was asked about. */
    checked: number;
    deleted: DeletedForm[];
    /** Embeds of another portal's forms: not this portal's to say anything about. */
    otherPortal: number;
    /** Why forms were not (all) read: a token without the forms scope, a page too big to scan, more embeds than are read. */
    unread?: string;
  };
  /** Pages and rows that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadHubspotCmsOptions {
  adapter: HubspotCmsAdapter;
  /** The fetcher for the live site's own pages (sent with no key). */
  fetcher: Fetcher;
  /** The address of the live site, such as https://brass-whisk.example. */
  site: string;
  /** Replaces HUBSPOT_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

const TOO_BIG = `the page is larger than ${HUBSPOT_READ_LIMITS.htmlChars / 1024} KB, so its words and forms were not read`;

/**
 * What one live page said: how it answered, and its HTML only while the forms and rows are read from it.
 * A page over the scan limit, or one the fetcher cut at its own size limit, is answered and not scanned.
 */
async function askLive(
  fetcher: Fetcher,
  url: string,
): Promise<{ answer: PageAnswer; html?: string; notScanned?: string }> {
  try {
    // A visitor with no session: nothing the fetcher adds per address goes along.
    const hops = await fetcher.get(url, { anonymous: true });
    const last = hops.at(-1);
    if (!last) return { answer: { kind: "unread", reason: "no answer" } };
    if (last.status >= 200 && last.status < 300) {
      const answer: PageAnswer = { kind: "page", status: last.status };
      if (last.truncated === true || (last.body?.length ?? 0) > HUBSPOT_READ_LIMITS.htmlChars)
        return { answer, notScanned: TOO_BIG };
      return last.body !== undefined
        ? { answer, html: last.body }
        : { answer, notScanned: "the page had no body" };
    }
    if (last.status === 404 || last.status === 410)
      return { answer: { kind: "missing", status: last.status } };
    return { answer: { kind: "unread", reason: `the site answered ${last.status}` } };
  } catch {
    return { answer: { kind: "unread", reason: "the page could not be fetched" } };
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const SKIPPED_ELEMENTS = new Set(["script", "style", "noscript"]);
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number): boolean => isLetter(c) || (c >= 48 && c <= 57) || c === 45;

/** The index of the closing tag `</name` (any case) at or after `from`, or -1. One pass, no backtracking. */
function findClosingTag(html: string, from: number, name: string): number {
  for (let at = html.indexOf("</", from); at !== -1; at = html.indexOf("</", at + 2)) {
    if (
      html.slice(at + 2, at + 2 + name.length).toLowerCase() === name &&
      !isNameChar(html.charCodeAt(at + 2 + name.length))
    )
      return at;
  }
  return -1;
}

/**
 * The words a visitor reads on a page: no scripts, styles, comments or tags, entities decoded, spaces
 * collapsed, lower case. One left-to-right pass built on indexOf, so hostile input (a page of unterminated
 * comments, tags or scripts) costs time in proportion to its length and no more. An unterminated comment,
 * tag, script or style hides the rest, as a browser shows it.
 */
export function visibleText(html: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break;
      out.push(" ");
      i = end + 3;
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    const letter = isLetter(next);
    // A tag starts with a letter, "/", "!" or "?": any other "<" is a character of the text.
    if (!letter && next !== 47 && next !== 33 && next !== 63) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    if (letter) {
      let e = lt + 1;
      while (e < gt && isNameChar(html.charCodeAt(e))) e++;
      const name = html.slice(lt + 1, e).toLowerCase();
      if (SKIPPED_ELEMENTS.has(name)) {
        const close = findClosingTag(html, gt + 1, name);
        const closeEnd = close === -1 ? -1 : html.indexOf(">", close);
        if (closeEnd === -1) break;
        out.push(" ");
        i = closeEnd + 1;
        continue;
      }
    }
    out.push(" ");
    i = gt + 1;
  }
  return out
    .join("")
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (m, dec, hex, name) => {
      if (name !== undefined) return ENTITIES[String(name).toLowerCase()] ?? m;
      const code = dec !== undefined ? Number(dec) : parseInt(String(hex), 16);
      return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The first place `needle` is in `text` with the test passing on both sides. indexOf only: no backtracking. */
function foundWithin(
  text: string,
  needle: string,
  before: (c: string) => boolean,
  after: (rest: string) => boolean,
): boolean {
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (
      (at === 0 || before(text.charAt(at - 1))) &&
      after(text.slice(at + needle.length, at + needle.length + 2))
    )
      return true;
  }
  return false;
}

const WORD = /[\p{L}\p{N}]/u;
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** Every way a number is written on a page: plain, with two decimals, with a decimal comma, with grouping. */
function numberForms(n: number): string[] {
  const [whole = "", fraction = ""] = String(Math.abs(n)).split(".");
  const fractions =
    fraction === "" ? ["", "00"] : fraction.length < 2 ? [fraction, `${fraction}0`] : [fraction];
  const forms = new Set<string>();
  for (const group of ["", ",", ".", " ", "'"]) {
    const grouped = group === "" ? whole : whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
    for (const f of fractions) {
      if (f === "") forms.add(grouped);
      else
        for (const decimal of [".", ","])
          if (decimal !== group) forms.add(`${grouped}${decimal}${f}`);
    }
  }
  return [...forms];
}

/**
 * Whether a column's value is on the page, looked for in the page's words (see visibleText):
 * - `true` / `false`: it was looked for, and found or not;
 * - `undefined`: it cannot be compared reliably, so it is not (a flag, a date in epoch milliseconds, a whole
 *   number under 100, text under 3 characters or over 300): never drift, never a pass.
 * A number is looked for as written, with two decimals, with a decimal comma and with grouping
 * (1,234.50 and 1.234,50 and 1 234,50), as a whole number and never inside a longer one (8.50 is not in 18.50).
 * Text must match whole words (rye is not found in dryer).
 */
export function valueOnPage(value: string | number | boolean, text: string): boolean | undefined {
  if (typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    // 1730419200000 is a date, and 5 is a number that is on every page.
    if (Number.isInteger(value) && (Math.abs(value) < 100 || Math.abs(value) >= 1e11))
      return undefined;
    if (/e/i.test(String(value))) return undefined;
    return numberForms(value).some((f) =>
      foundWithin(
        text,
        f,
        (c) => !isDigit(c) && c !== "." && c !== ",",
        (rest) =>
          !isDigit(rest.charAt(0)) && !(/[.,]/.test(rest.charAt(0)) && isDigit(rest.charAt(1))),
      ),
    );
  }
  if (value.length > HUBSPOT_READ_LIMITS.valueChars) return undefined;
  const wanted = visibleText(value);
  if (wanted.length < 3) return undefined;
  return foundWithin(
    text,
    wanted,
    (c) => !WORD.test(c),
    (rest) => !WORD.test(rest.charAt(0)),
  );
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const FORM_ID_IN_CALL = new RegExp(`["']?\\bformId["']?\\s*:\\s*["'](${UUID})["']`);
const PORTAL_ID_IN_CALL = /["']?\bportalId["']?\s*:\s*["']?(\d{1,12})\b/;
const FORM_ID_ATTR = new RegExp(`\\bdata-form-id\\s*=\\s*["'](${UUID})["']`);
const PORTAL_ID_ATTR = /\bdata-portal-id\s*=\s*["'](\d{1,12})["']/;
const CREATE_CALL = "hbspt.forms.create(";
const CALL_CHARS = 3000;
const TAG_CHARS = 1500;
const MAX_LOOKS = 200;

/** The text of the call whose "(" is at `open`: to its matching ")", skipping quoted text, at most CALL_CHARS. */
function callText(html: string, open: number): string {
  let depth = 0;
  let quote = "";
  const end = Math.min(html.length, open + CALL_CHARS);
  for (let i = open; i < end; i++) {
    const ch = html.charAt(i);
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return html.slice(open, i);
  }
  return html.slice(open, end);
}

/**
 * The HubSpot form embeds a page names, each with the portal of its own embed: the object given to one
 * `hbspt.forms.create(...)` call, or one element with `data-form-id` and `data-portal-id`. A `formId` anywhere
 * else (another vendor's script) is not a HubSpot form and is not read. Read as text and never run. More than
 * HUBSPOT_READ_LIMITS.formsPerPage embeds on a page is `truncated`: the rest are not read.
 */
export function formEmbeds(html: string): {
  forms: { formId: string; portalId?: string }[];
  truncated: boolean;
} {
  const forms: { formId: string; portalId?: string }[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const add = (formId: string | undefined, portalId: string | undefined): void => {
    if (formId === undefined || truncated) return;
    const id = formId.toLowerCase();
    const key = `${id}@${portalId ?? ""}`;
    if (seen.has(key)) return;
    if (forms.length >= HUBSPOT_READ_LIMITS.formsPerPage) {
      truncated = true;
      return;
    }
    seen.add(key);
    forms.push({ formId: id, ...(portalId !== undefined ? { portalId } : {}) });
  };
  // Every occurrence costs a short look; a page with far more than it could hold is cut off, not ground through.
  let looks = 0;
  for (let at = html.indexOf(CREATE_CALL); at !== -1; at = html.indexOf(CREATE_CALL, at + 1)) {
    if (++looks > MAX_LOOKS) return { forms, truncated: true };
    const call = callText(html, at + CREATE_CALL.length - 1);
    add(FORM_ID_IN_CALL.exec(call)?.[1], PORTAL_ID_IN_CALL.exec(call)?.[1]);
  }
  for (
    let at = html.indexOf("data-form-id");
    at !== -1;
    at = html.indexOf("data-form-id", at + 1)
  ) {
    if (++looks > MAX_LOOKS) return { forms, truncated: true };
    // The element is the "<" before the attribute to the ">" after it, within a short window.
    const from = Math.max(0, at - TAG_CHARS);
    const window = html.slice(from, at + TAG_CHARS);
    const start = window.lastIndexOf("<", at - from);
    const end = window.indexOf(">", at - from);
    if (start === -1 || end === -1) continue;
    const tag = window.slice(start, end);
    add(FORM_ID_ATTR.exec(tag)?.[1], PORTAL_ID_ATTR.exec(tag)?.[1]);
  }
  return { forms, truncated };
}

interface Ask {
  /** What a page or a row is, for filling the reading in. */
  page?: { id: string; type: HubspotPageKind; slug?: string };
  row?: {
    table: string;
    id: string;
    columns: Record<string, string | number | boolean>;
    notCompared: string[];
  };
  url: URL;
}

const PAGE_PARTS = new Set<string>(Object.keys(HUBSPOT_PAGE_KINDS));

/**
 * Read a HubSpot site for the HubSpot checks. The published pages of the three CMS lists whose address is on
 * this domain are asked for once each (a page of another domain of the same portal is counted and never
 * asked); the rows of each HubDB table the settings name columns for are compared with the dynamic page that
 * shows them; the form embeds in the pages read are asked about, one GET for each different form. A part
 * the token may not read is recorded with its reason and the others are still read; a rate limit that stays
 * ends the read and marks it partial. Every address asked of the live site is a public page.
 */
export async function readHubspotCms(options: ReadHubspotCmsOptions): Promise<HubspotCmsReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const siteHost = bare(new URL(origin).host);
  const budget = options.maxPages ?? HUBSPOT_READ_LIMITS.pages;
  const reading: HubspotCmsReading = {
    site: origin,
    pages: [],
    otherDomain: 0,
    noAddress: 0,
    statesUnrecognised: 0,
    unreadable: [],
    hubdb: [],
    hubdbWithoutPage: [],
    hubdbRowsWithoutPath: 0,
    forms: { checked: 0, deleted: [], otherPortal: 0 },
    pagesSkipped: 0,
    pageBudget: budget,
  };
  const limited = (err: AdapterRateLimitedError, delivered: number): void => {
    reading.partial = {
      reason: "rate-limited",
      ...(err.retry !== undefined ? { retry: err.retry } : {}),
      delivered,
    };
  };

  const asks: Ask[] = [];
  const dynamic = new Map<string, URL>();
  for (const kind of Object.keys(HUBSPOT_PAGE_KINDS) as HubspotPageKind[]) {
    if (reading.partial) break;
    try {
      for await (const p of adapter.livePages(
        kind,
        undefined,
        () => reading.statesUnrecognised++,
      )) {
        const url = p.url === undefined ? undefined : liveAddress(p.url);
        if (url === undefined) {
          reading.noAddress++;
          continue;
        }
        if (bare(url.host) !== siteHost) {
          reading.otherDomain++;
          continue;
        }
        if (p.hubdbTableId !== undefined && !dynamic.has(p.hubdbTableId))
          dynamic.set(p.hubdbTableId, url);
        asks.push({
          page: { id: p.id, type: kind, ...(p.slug !== undefined ? { slug: p.slug } : {}) },
          url,
        });
      }
    } catch (err) {
      if (err instanceof PartRefused) reading.unreadable.push({ part: kind, reason: err.reason });
      else if (err instanceof AdapterRateLimitedError) limited(err, asks.length);
      else throw err;
    }
  }

  const named = adapter.hubdbNamed();
  if (named.length > 0 && !reading.partial) {
    // A table whose dynamic page may be in a list that was not (all) read is not "a table with no page".
    const pagesIncomplete =
      reading.unreadable.some((u) => PAGE_PARTS.has(u.part)) || reading.statesUnrecognised > 0;
    try {
      const tables = await adapter.hubdbTables();
      for (const n of named) {
        const table = tables.find((t) => t.name === n.table);
        if (table === undefined) {
          reading.unreadable.push({
            part: `hubdb.${n.table}`,
            reason: "HubSpot has no published HubDB table with this name.",
          });
          continue;
        }
        const base = dynamic.get(table.id);
        if (base === undefined) {
          if (pagesIncomplete)
            reading.unreadable.push({
              part: `hubdb.${n.table}`,
              reason: "the pages that would show it were not all read",
            });
          else reading.hubdbWithoutPage.push(n.table);
          continue;
        }
        try {
          for (const row of await adapter.hubdbRows(n.table, n.columns, table.dateColumns)) {
            if (row.path === undefined) {
              reading.hubdbRowsWithoutPath++;
              continue;
            }
            const url = liveAddress(
              `${base.origin}${base.pathname.replace(/\/$/, "")}/${row.path}`,
            );
            if (url === undefined) {
              reading.hubdbRowsWithoutPath++;
              continue;
            }
            asks.push({
              row: {
                table: n.table,
                id: row.id,
                columns: row.columns,
                notCompared: row.notCompared,
              },
              url,
            });
          }
        } catch (err) {
          if (err instanceof AdapterRateLimitedError) {
            limited(err, asks.length);
            break;
          }
          if (!(err instanceof AdapterCouldNotCheck)) throw err;
          reading.unreadable.push({ part: `hubdb.${n.table}`, reason: err.reason });
        }
      }
    } catch (err) {
      if (err instanceof AdapterRateLimitedError) limited(err, asks.length);
      else if (err instanceof AdapterCouldNotCheck)
        reading.unreadable.push({ part: "hubdb", reason: err.reason });
      else throw err;
    }
  }

  // Pages first, then rows: when the budget runs out it is the rows that are left, and they are counted.
  const ordered = [...asks.filter((a) => a.page), ...asks.filter((a) => a.row)];
  const asked = ordered.slice(0, budget);
  reading.pagesSkipped = ordered.length - asked.length;
  const embeds: {
    path: string;
    forms: { formId: string; portalId?: string }[];
    truncated: boolean;
  }[] = [];
  let unscanned = 0;
  await Promise.all(
    asked.map(async (a) => {
      const got = await askLive(fetcher, a.url.href);
      if (a.page)
        reading.pages.push({
          ...a.page,
          url: a.url.href,
          path: a.url.pathname,
          answer: got.answer,
        });
      if (got.answer.kind === "page" && got.html === undefined) unscanned++;
      if (got.answer.kind !== "page" || got.html === undefined) {
        if (a.row)
          reading.hubdb.push({
            table: a.row.table,
            rowId: a.row.id,
            path: a.url.pathname,
            state: "unread",
            columns: [],
            notCompared: a.row.notCompared,
            reason:
              got.notScanned ??
              (got.answer.kind === "unread"
                ? got.answer.reason
                : `the page answered ${got.answer.status}`),
          });
        return;
      }
      if (a.row) {
        const text = visibleText(got.html);
        const differing: string[] = [];
        const notCompared = [...a.row.notCompared];
        let compared = 0;
        for (const [column, value] of Object.entries(a.row.columns)) {
          const on = valueOnPage(value, text);
          if (on === undefined) {
            notCompared.push(column);
            continue;
          }
          compared++;
          if (!on) differing.push(column);
        }
        reading.hubdb.push({
          table: a.row.table,
          rowId: a.row.id,
          path: a.url.pathname,
          state: differing.length > 0 ? "differs" : compared > 0 ? "matches" : "unread",
          columns: differing.sort(),
          notCompared: notCompared.sort(),
          ...(compared === 0 && differing.length === 0
            ? { reason: "no column of this row has a value that can be looked for on the page" }
            : {}),
        });
      }
      const e = formEmbeds(got.html);
      if (e.forms.length > 0) embeds.push({ path: a.url.pathname, ...e });
    }),
  );
  // Promise.all finishes in the order the pages answered: the reading is put in a stable order.
  const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  reading.pages.sort((x, y) => cmp(x.url, y.url));
  reading.hubdb.sort((x, y) => cmp(`${x.table}/${x.rowId}`, `${y.table}/${y.rowId}`));
  embeds.sort((x, y) => cmp(x.path, y.path));

  const notes = new Set<string>();
  if (unscanned > 0)
    notes.add(
      `${unscanned} ${unscanned === 1 ? "page was" : "pages were"} not scanned for forms: ${TOO_BIG}`,
    );
  if (embeds.length > 0 && !reading.partial)
    await readForms(adapter, embeds, reading, limited, notes);
  if (notes.size > 0) reading.forms.unread = [...notes].join("; ");
  return reading;
}

/** Ask HubSpot about each different form the pages embed. Only this portal's forms are judged. */
async function readForms(
  adapter: HubspotCmsAdapter,
  embeds: { path: string; forms: { formId: string; portalId?: string }[]; truncated: boolean }[],
  reading: HubspotCmsReading,
  limited: (err: AdapterRateLimitedError, delivered: number) => void,
  notes: Set<string>,
): Promise<void> {
  let portal: string;
  try {
    portal = await adapter.portalId();
  } catch (err) {
    if (err instanceof AdapterRateLimitedError) return limited(err, reading.pages.length);
    if (!(err instanceof AdapterCouldNotCheck)) throw err;
    notes.add(`the token's portal was not read (${err.reason})`);
    return;
  }
  // formId -> the paths of the pages that embed it. A form is judged only against the portal its own embed names.
  const wanted = new Map<string, Set<string>>();
  for (const e of embeds) {
    if (e.truncated)
      notes.add(
        `a page embeds more than ${HUBSPOT_READ_LIMITS.formsPerPage} forms, so the rest of its forms were not read`,
      );
    for (const f of e.forms) {
      if (f.portalId === undefined) {
        notes.add("an embed names no portal, so its form was not asked about");
        continue;
      }
      if (f.portalId !== portal) {
        reading.forms.otherPortal++;
        continue;
      }
      const paths = wanted.get(f.formId) ?? new Set<string>();
      paths.add(e.path);
      wanted.set(f.formId, paths);
    }
  }
  const ids = [...wanted.keys()].sort();
  for (const id of ids.slice(0, HUBSPOT_READ_LIMITS.forms)) {
    try {
      const state = await adapter.formState(id);
      reading.forms.checked++;
      if (state === "deleted")
        reading.forms.deleted.push({ formId: id, paths: [...(wanted.get(id) ?? [])].sort() });
    } catch (err) {
      if (err instanceof AdapterRateLimitedError) return limited(err, reading.pages.length);
      if (!(err instanceof AdapterCouldNotCheck)) throw err;
      notes.add(
        err instanceof PartRefused
          ? "the token may not read HubSpot forms (it needs the forms read scope)"
          : err.reason,
      );
      return;
    }
  }
  if (ids.length > HUBSPOT_READ_LIMITS.forms)
    notes.add(
      `${ids.length - HUBSPOT_READ_LIMITS.forms} more forms were not asked about, because a run asks about at most ${HUBSPOT_READ_LIMITS.forms}`,
    );
}
