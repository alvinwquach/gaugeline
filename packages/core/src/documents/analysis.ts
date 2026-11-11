import { venueZone } from "../checks/events/events.js";
import type { CheckContext } from "../model.js";
import { DAYS, type Day } from "../facts/normalise.js";
import { LIMITS } from "../limits.js";
import {
  describeDay,
  dayLabel,
  mergeIntervals,
  parseListedHours,
  type DayHours,
} from "../listings/hours.js";
import { readSiteFacts, todayIn } from "../listings/site.js";
import { normaliseName } from "../products/match.js";
import { toMinor } from "../products/money.js";
import type { PageSnapshot } from "../snapshot.js";
import { compareDocument, type Comparison } from "./compare.js";
import { findDocumentLinks } from "./links.js";
import { parseItemLines, type DocItem } from "./lines.js";
import { readDocument } from "./read.js";
import {
  INSTALL_HINT,
  loadDocumentReader,
  type DocumentReader,
  type ReferenceItem,
} from "./types.js";

/** Reasons a reader gives that are findings (document-unreadable, info). The rest are could-not-check. */
const UNREADABLE_FINDINGS = new Set([
  "encrypted",
  "no-text-layer",
  "undecodable-fonts",
  "unsupported-streams",
  "too-complex",
]);

export interface AnalysedDocument {
  /** The address the file was read from, after any redirect. */
  url: string;
  lastModified?: string;
  /** The document could not be read, and why (a finding). */
  unreadable?: string;
  /** The document could not be fetched or read (could-not-check). */
  notRead?: string;
  pages: number;
  items: number;
  comparison?: Comparison;
  /** One sentence per day or source where the hours differ. */
  hourDifferences: string[];
  /** Where the site's own hours came from, for the evidence. */
  siteHoursFrom?: string;
  /** The document states hours but there was nothing to compare them with. */
  hoursNotCompared?: string;
}

export interface Analysis {
  documents: AnalysedDocument[];
  /** Notes that apply to every document check (more documents linked than are read). */
  notes: { url: string; reason: string }[];
}

const cache = new WeakMap<CheckContext, Promise<Analysis>>();

function factsReference(ctx: CheckContext): ReferenceItem[] {
  const out: ReferenceItem[] = [];
  for (const f of ctx.facts?.facts ?? []) {
    if (f.kind !== "price") continue;
    const add = (name: string, value: string, size?: string): void => {
      try {
        out.push({
          name,
          key: normaliseName(name),
          amount: toMinor(value.replace(/[^\d.,]/g, "").replace(",", ".")),
          ...(size ? { size } : {}),
          source: "gaugeline.facts.json",
        });
      } catch {
        // a value that is not a price is not a source
      }
    };
    add(f.item, f.value);
    for (const v of f.variants ?? []) add(f.item, v.value, v.name);
  }
  return out;
}

/** The days the document states, compared with a source's hours; the source's other days are not asked. */
function differ(doc: DayHours, other: DayHours, who: string): string[] {
  return DAYS.flatMap((day: Day) => {
    const stated = doc[day];
    const theirs = other[day];
    if (stated === undefined || theirs === undefined) return [];
    const a = mergeIntervals(stated);
    const b = mergeIntervals(theirs);
    const same =
      a.length === b.length && a.every((v, i) => v[0] === b[i]?.[0] && v[1] === b[i]?.[1]);
    return same
      ? []
      : [`${dayLabel(day)}: the document says ${describeDay(a)}, ${who} says ${describeDay(b)}`];
  });
}

async function analyse(page: PageSnapshot, ctx: CheckContext): Promise<Analysis> {
  const analysis: Analysis = { documents: [], notes: [] };
  const fetcher = ctx.fetcher;
  const pages = (await ctx.pages?.()) ?? [page];
  const config = ctx.documents?.config?.documents;
  const links = findDocumentLinks(pages, config);
  if (links.length === 0 || !fetcher) return analysis;
  const wanted = links.map((l) => l.url);
  const taken = ctx.budget
    ? ctx.budget.take("documents", wanted)
    : wanted.slice(0, LIMITS.documents);
  for (const url of wanted.slice(taken.length))
    analysis.notes.push({
      url,
      reason: `not read: more than ${LIMITS.documents} documents are linked, and only the first ${LIMITS.documents} are read`,
    });

  const reader: DocumentReader | undefined = ctx.documents?.reader ?? (await loadDocumentReader());
  if (!reader) {
    for (const url of taken)
      analysis.documents.push({
        url,
        notRead: INSTALL_HINT,
        pages: 0,
        items: 0,
        hourDifferences: [],
      });
    return analysis;
  }

  const maxBytes = Math.round(
    (config?.maxMegabytes ?? LIMITS.documentBytes / (1024 * 1024)) * 1024 * 1024,
  );
  const reference = [...((await ctx.documents?.reference?.()) ?? []), ...factsReference(ctx)];
  const pageTexts = pages.map((p) => ({
    path: new URL(p.finalUrl).pathname,
    text: p.visibleText ?? "",
  }));
  const site = readSiteFacts(pages, ctx.facts, todayIn(ctx.now?.() ?? new Date(), venueZone(ctx)));
  const listings = ctx.listings ? await ctx.listings() : undefined;

  for (const url of taken) {
    const out = await readDocument(url, { fetcher, reader, maxBytes });
    if (out.kind === "page") continue;
    if (out.kind === "not-read") {
      analysis.documents.push({
        url: out.url,
        notRead: out.reason,
        pages: 0,
        items: 0,
        hourDifferences: [],
      });
      continue;
    }
    const base = {
      url: out.url,
      ...(out.lastModified ? { lastModified: out.lastModified } : {}),
      hourDifferences: [] as string[],
    };
    if (!out.text.ok) {
      analysis.documents.push(
        UNREADABLE_FINDINGS.has(out.text.reason)
          ? { ...base, unreadable: out.text.message, pages: 0, items: 0 }
          : { ...base, notRead: out.text.message, pages: 0, items: 0 },
      );
      continue;
    }
    const text = out.text.pages.join("\n");
    const items: DocItem[] = parseItemLines(text);
    const doc: AnalysedDocument = {
      ...base,
      pages: out.text.pages.length,
      items: items.length,
      comparison: compareDocument(items, reference, pageTexts),
    };
    const hours = parseListedHours(text);
    if (Object.keys(hours).length > 0) {
      if (site.hours) doc.siteHoursFrom = site.hours.from;
      if (site.hours) doc.hourDifferences.push(...differ(hours, site.hours.value, "your site"));
      for (const l of listings?.listings ?? [])
        if (l.source !== "bio-link" && l.status !== "closed-permanently" && l.hours)
          doc.hourDifferences.push(...differ(hours, l.hours, l.label));
      if (!site.hours && !(listings?.listings ?? []).some((l) => l.hours))
        doc.hoursNotCompared =
          "the document states opening hours but the site states none (add an hours fact to gaugeline.facts.json, or LocalBusiness openingHours) and no listing is configured";
    }
    analysis.documents.push(doc);
  }
  return analysis;
}

/** The documents of this run, read once for the four checks (the context is one run's). */
export function analyseDocuments(page: PageSnapshot, ctx: CheckContext): Promise<Analysis> {
  let pending = cache.get(ctx);
  if (!pending) {
    pending = analyse(page, ctx);
    cache.set(ctx, pending);
  }
  return pending;
}
