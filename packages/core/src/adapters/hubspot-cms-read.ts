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
  /** Form embeds read from one page. */
  formsPerPage: 20,
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
    /** Why forms were not read at all (a token without the forms scope), or undefined. */
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

/** What one live page said: how it answered, and its HTML only while the forms and rows are read from it. */
async function askLive(
  fetcher: Fetcher,
  url: string,
): Promise<{ answer: PageAnswer; html?: string }> {
  try {
    // A visitor with no session: nothing the fetcher adds per address goes along.
    const hops = await fetcher.get(url, { anonymous: true });
    const last = hops.at(-1);
    if (!last) return { answer: { kind: "unread", reason: "no answer" } };
    if (last.status >= 200 && last.status < 300)
      return {
        answer: { kind: "page", status: last.status },
        ...(last.body !== undefined ? { html: last.body } : {}),
      };
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

/** The words a visitor reads on a page: no scripts, styles, comments or tags, entities decoded, spaces collapsed. */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when a column's value is on the page. Text is compared as the words a visitor reads (HubDB's rich
 * text has its tags removed first). A number is looked for as written, with two decimals and with a
 * thousands comma, and only as a whole number (8 is not found in 18.00). A value of another kind
 * (a list, a flag) is not compared: it is `undefined`, which the caller reports as not compared.
 */
export function valueOnPage(value: string | number | boolean, text: string): boolean | undefined {
  if (typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const forms = new Set([
      String(value),
      value.toFixed(2),
      value.toLocaleString("en-US", { maximumFractionDigits: 20 }),
    ]);
    return [...forms].some((f) =>
      new RegExp(`(?<![\\d.,])${escapeRe(f)}(?!\\d|[.,]\\d)`).test(text),
    );
  }
  const wanted = visibleText(value);
  if (wanted === "") return undefined;
  return text.includes(wanted);
}

const FORM_ID_PATTERNS = [
  /\bdata-form-id\s*=\s*["']([0-9a-fA-F-]{36})["']/g,
  /["']?\bformId["']?\s*[:=]\s*["']([0-9a-fA-F-]{36})["']/g,
];
const PORTAL_PATTERNS = [
  /\bdata-portal-id\s*=\s*["'](\d{1,12})["']/g,
  /["']?\bportalId["']?\s*[:=]\s*["']?(\d{1,12})\b/g,
];

/** The form ids and portal ids a page's HubSpot embeds name. Read from the HTML as text and never run. */
export function formEmbeds(html: string): { formIds: string[]; portalIds: string[] } {
  const grab = (patterns: RegExp[]): string[] => {
    const out = new Set<string>();
    for (const p of patterns)
      for (const m of html.matchAll(p)) {
        if (m[1] !== undefined && out.size < HUBSPOT_READ_LIMITS.formsPerPage)
          out.add(m[1].toLowerCase());
      }
    return [...out];
  };
  return {
    formIds: grab(FORM_ID_PATTERNS).filter((f) =>
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(f),
    ),
    portalIds: grab(PORTAL_PATTERNS),
  };
}

interface Ask {
  /** What a page or a row is, for filling the reading in. */
  page?: { id: string; type: HubspotPageKind; slug?: string };
  row?: { table: string; id: string; columns: Record<string, string | number | boolean> };
  url: URL;
}

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
      for await (const p of adapter.livePages(kind)) {
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
          reading.hubdbWithoutPage.push(n.table);
          continue;
        }
        try {
          for (const row of await adapter.hubdbRows(n.table, n.columns)) {
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
            asks.push({ row: { table: n.table, id: row.id, columns: row.columns }, url });
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
  const embeds: { formIds: string[]; portalIds: string[]; path: string }[] = [];
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
      if (got.answer.kind !== "page" || got.html === undefined) {
        if (a.row)
          reading.hubdb.push({
            table: a.row.table,
            rowId: a.row.id,
            path: a.url.pathname,
            state: "unread",
            columns: [],
            reason:
              got.answer.kind === "unread"
                ? got.answer.reason
                : `the page answered ${got.answer.status}`,
          });
        return;
      }
      if (a.row) {
        const text = visibleText(got.html);
        const differing: string[] = [];
        let compared = 0;
        for (const [column, value] of Object.entries(a.row.columns)) {
          const on = valueOnPage(value, text);
          if (on === undefined) continue;
          compared++;
          if (!on) differing.push(column);
        }
        reading.hubdb.push({
          table: a.row.table,
          rowId: a.row.id,
          path: a.url.pathname,
          state: differing.length > 0 ? "differs" : compared > 0 ? "matches" : "unread",
          columns: differing.sort(),
          ...(compared === 0 && differing.length === 0
            ? { reason: "no column of this row has a value that can be looked for on the page" }
            : {}),
        });
      }
      const e = formEmbeds(got.html);
      if (e.formIds.length > 0) embeds.push({ ...e, path: a.url.pathname });
    }),
  );
  // Promise.all finishes in the order the pages answered: the reading is put in a stable order.
  reading.pages.sort((x, y) => (x.url < y.url ? -1 : x.url > y.url ? 1 : 0));
  reading.hubdb.sort((x, y) =>
    `${x.table}/${x.rowId}` < `${y.table}/${y.rowId}`
      ? -1
      : `${x.table}/${x.rowId}` > `${y.table}/${y.rowId}`
        ? 1
        : 0,
  );

  if (embeds.length > 0 && !reading.partial) await readForms(adapter, embeds, reading, limited);
  return reading;
}

/** Ask HubSpot about each different form the pages embed. Only this portal's forms are judged. */
async function readForms(
  adapter: HubspotCmsAdapter,
  embeds: { formIds: string[]; portalIds: string[]; path: string }[],
  reading: HubspotCmsReading,
  limited: (err: AdapterRateLimitedError, delivered: number) => void,
): Promise<void> {
  let portal: string;
  try {
    portal = await adapter.portalId();
  } catch (err) {
    if (err instanceof AdapterRateLimitedError) return limited(err, reading.pages.length);
    if (!(err instanceof AdapterCouldNotCheck)) throw err;
    reading.forms.unread = `the token's portal was not read (${err.reason})`;
    return;
  }
  // formId -> the paths of the pages that embed it; a page that names two portals cannot be paired.
  const wanted = new Map<string, Set<string>>();
  for (const e of embeds) {
    if (e.portalIds.length !== 1 || e.portalIds[0] !== portal) {
      if (e.portalIds.length > 0 && !e.portalIds.includes(portal))
        reading.forms.otherPortal += e.formIds.length;
      else
        reading.forms.unread ??=
          "a page embeds forms and names more than one portal, or none, so its forms were not asked about";
      continue;
    }
    for (const f of e.formIds) {
      const paths = wanted.get(f) ?? new Set<string>();
      paths.add(e.path);
      wanted.set(f, paths);
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
      reading.forms.unread =
        err instanceof PartRefused
          ? "the token may not read HubSpot forms (it needs the forms read scope)"
          : err.reason;
      return;
    }
  }
  if (ids.length > HUBSPOT_READ_LIMITS.forms)
    reading.forms.unread = `${ids.length - HUBSPOT_READ_LIMITS.forms} more forms were not asked about, because a run asks about at most ${HUBSPOT_READ_LIMITS.forms}`;
}
