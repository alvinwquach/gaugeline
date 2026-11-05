import type { CheckContext } from "../../model.js";
import { extractPayments } from "../../payments/extract.js";
import type { PaymentKind, PaymentsConfig } from "../../payments/types.js";
import { configValue } from "../../payments/extract.js";
import type { PageSnapshot } from "../../snapshot.js";
import { firstFew } from "../site-helpers.js";

/** One distinct payment detail, and every page it is on. */
export interface PaymentGroup {
  kind: PaymentKind;
  value: string;
  /** As first written. */
  raw: string;
  /** The words around its first appearance as text, or "" when it is only ever a link. */
  context: string;
  /** Pages it is on, in the order they were read. */
  paths: string[];
}

/**
 * The pages to read: the checked page and the run's other pages, when payments are configured or
 * the checked page shows a payment detail. Otherwise only the checked page, so a site that takes
 * no payments costs no extra request.
 */
export async function paymentPages(page: PageSnapshot, ctx: CheckContext): Promise<PageSnapshot[]> {
  if (!ctx.payments && extractPayments(page).length === 0) return [page];
  return (await ctx.pages?.()) ?? [page];
}

/**
 * Payment details grouped by kind and value, across pages. A Map keyed by "kind value" keeps the
 * order they were first seen, and gives one entry, so one finding, per distinct value however
 * many pages repeat it (a footer on 40 pages is one fix).
 */
export function groupPayments(pages: readonly PageSnapshot[]): PaymentGroup[] {
  const groups = new Map<string, PaymentGroup>();
  for (const page of pages) {
    for (const d of extractPayments(page)) {
      const key = `${d.kind} ${d.value}`;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, {
          kind: d.kind,
          value: d.value,
          raw: d.raw,
          context: d.context,
          paths: [d.path],
        });
        continue;
      }
      if (!g.paths.includes(d.path)) g.paths.push(d.path);
      if (g.context === "" && d.context !== "") g.context = d.context;
    }
  }
  return [...groups.values()];
}

/** Configured values by kind: kind -> (comparable value -> value as configured). */
export function configured(config: PaymentsConfig): Map<PaymentKind, Map<string, string>> {
  const out = new Map<PaymentKind, Map<string, string>>();
  for (const p of config.payments) {
    const value = configValue(p.kind, p.value);
    if (value === undefined) continue;
    const values = out.get(p.kind) ?? new Map<string, string>();
    values.set(value, p.value);
    out.set(p.kind, values);
  }
  return out;
}

/** "/es/", or "40 pages (/, /p1, /p2 and 37 more)". */
export function onPages(paths: readonly string[]): string {
  return paths.length === 1 ? (paths[0] ?? "") : `${paths.length} pages (${firstFew(paths)})`;
}

/** ' ("Paga con Venmo: @x")', or "" for a detail that is only ever a link. */
export function around(g: PaymentGroup): string {
  return g.context === "" ? "" : ` ("${g.context}")`;
}
