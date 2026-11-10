import type { AdsData, Finding, Level, Result } from "../types";

/** A finding of the run, by its place in `result.findings`: what the Problems view's address names. */
export interface FindingRef {
  index: number;
  checkId: string;
  severity: Level;
  title: string;
}

/** One landing page: how many ads send people there, what they cost (minor units), and what was found. */
export interface DestinationRow {
  url: string;
  ads: number;
  spend: number;
  findings: FindingRef[];
}

/** One currency's summary and table. Amounts of different currencies are never in the same one. */
export interface CurrencyModel {
  currency: string | null;
  totalSpend: number;
  /** The spend of the destinations that have at least one finding, each counted once. */
  problemSpend: number;
  destinations: DestinationRow[];
}

export interface AdsModel {
  currencies: CurrencyModel[];
  /** Findings about an address that is not one of the export's destinations. Shown, never dropped. */
  unplaced: FindingRef[];
}

function sum(rows: readonly { spend: number }[]): number {
  let total = 0;
  for (const r of rows) {
    total += r.spend;
    if (!Number.isSafeInteger(total))
      throw new RangeError("The spend in this export is too large to add up exactly.");
  }
  return total;
}

/**
 * The ads view's rows from a run's result and its destinations. Findings are matched to a
 * destination by address with a Map, one pass over the findings; each row keeps the findings'
 * indexes so a click opens the same finding in Problems. Rows sort by the spend on pages with
 * problems (highest first), then by total spend, then by address, so the order is the same
 * whichever order the server listed them in. Spend is only ever added as integers, per currency.
 */
export function toAdsModel(result: Result, data: AdsData): AdsModel {
  const byUrl = new Map<string, FindingRef[]>();
  const ref = (f: Finding, index: number): FindingRef => ({
    index,
    checkId: f.checkId,
    severity: f.severity,
    title: f.title,
  });
  result.findings.forEach((f, index) => {
    const list = byUrl.get(f.url);
    if (list) list.push(ref(f, index));
    else byUrl.set(f.url, [ref(f, index)]);
  });
  const known = new Set<string>();
  const currencies = data.currencies.map((c): CurrencyModel => {
    const destinations = c.destinations.map((d): DestinationRow => {
      known.add(d.url);
      return { url: d.url, ads: d.ads, spend: d.spend, findings: byUrl.get(d.url) ?? [] };
    });
    const withProblems = destinations.filter((d) => d.findings.length > 0);
    const problemOf = (d: DestinationRow) => (d.findings.length > 0 ? d.spend : 0);
    destinations.sort(
      (a, b) =>
        problemOf(b) - problemOf(a) ||
        b.spend - a.spend ||
        (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
    );
    return {
      currency: c.currency,
      totalSpend: sum(destinations),
      problemSpend: sum(withProblems),
      destinations,
    };
  });
  const unplaced: FindingRef[] = [];
  result.findings.forEach((f, index) => {
    if (!known.has(f.url)) unplaced.push(ref(f, index));
  });
  return { currencies, unplaced };
}
