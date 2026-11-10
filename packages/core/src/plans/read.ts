import { toMinor } from "../products/money.js";
import type { PageSnapshot } from "../snapshot.js";
import { findName, sameName, visibleLines } from "../switches/text.js";
import { planKey, type PlansConfig } from "./config.js";
import {
  cadenceUnclear,
  findAmounts,
  hasPromoWords,
  parseCadence,
  parseTaxDisplay,
  parseTrial,
  type Cadence,
  type ShownAmount,
  type TaxDisplay,
  type TrialDays,
} from "./phrases.js";

/** The lines of a plan's card that are read after its name. Cards are short; this keeps a read inside one. */
export const PLAN_BLOCK_LINES = 8;

/** A page's visible text, and the address it was read from. */
export interface PlanPage {
  url: string;
  text: string;
}

/** The text a visitor can read on a snapshot, as a plan page. */
export function planPageOf(page: PageSnapshot): PlanPage {
  return { url: page.finalUrl, text: visibleLines(page) };
}

/**
 * One plan as the page shows it. Everything here is what the page says, read as plain text: no
 * rendering, nothing followed. A field is null when the page does not say it.
 */
export interface PagePlan {
  /** The plan's id (`gaugeline.plans.json`, or the name as hyphenated words). */
  id: string;
  name: string;
  /** The address the page was read from, or the configured path when it could not be read. */
  url: string;
  /** The Stripe price the configuration names for this plan. */
  priceId?: string;
  /** "found": the name is on the page. "missing": it is not, or the page was not read. */
  state: "found" | "missing";
  /** The line the plan starts at, as written. */
  heading: string;
  amount: ShownAmount | null;
  cadence: Cadence | null;
  /** The card names two different billing intervals, so none was chosen. */
  cadenceUnclear: boolean;
  trial: TrialDays | null;
  tax: TaxDisplay | null;
  /** An introductory price, coupon or discount is shown and the configuration does not say which amount it is. */
  promo: boolean;
}

function sameAmount(a: string, b: string): boolean {
  try {
    return toMinor(a) === toMinor(b);
  } catch {
    return false;
  }
}

function blankPlan(p: PlansConfig["plans"][number], url: string): PagePlan {
  return {
    id: planKey(p),
    name: p.name,
    url,
    ...(p.price === undefined ? {} : { priceId: p.price }),
    state: "missing",
    heading: "",
    amount: null,
    cadence: null,
    cadenceUnclear: false,
    trial: null,
    tax: null,
    promo: false,
  };
}

/**
 * Read each configured plan from the page that shows it. The plan starts at the first line that is
 * its name alone (else the first line that contains it) and runs to the next configured plan's
 * name on that page, or PLAN_BLOCK_LINES lines. From those lines: the first amount written with a
 * currency, how often it bills, a free trial, and whether tax is said to be in or on top. A plan
 * whose name is not on the page, or whose page was not read, is "missing".
 */
export function readPagePlans(
  config: PlansConfig,
  pageFor: (path: string) => PlanPage | undefined,
): PagePlan[] {
  return config.plans.map((plan) => {
    const page = pageFor(plan.page);
    if (page === undefined) return blankPlan(plan, plan.page);
    const lines = page.text.split("\n");
    let start = lines.findIndex((l) => sameName(l, plan.name));
    if (start === -1) start = lines.findIndex((l) => findName(l, plan.name).length > 0);
    if (start === -1) return blankPlan(plan, page.url);
    const others = config.plans.filter((o) => o !== plan && o.page === plan.page);
    let end = Math.min(lines.length, start + PLAN_BLOCK_LINES);
    for (let i = start + 1; i < end; i++)
      if (others.some((o) => sameName(lines[i] ?? "", o.name))) {
        end = i;
        break;
      }
    const block = lines.slice(start, end).join("\n");

    let amounts = findAmounts(block);
    let introSetAside = false;
    if (plan.introAmount !== undefined) {
      const intro = plan.introAmount;
      const at = amounts.findIndex((a) => sameAmount(a.text, intro));
      if (at !== -1) {
        amounts = amounts.filter((_, i) => i !== at);
        introSetAside = true;
      }
    }
    return {
      ...blankPlan(plan, page.url),
      state: "found",
      heading: lines[start] ?? "",
      amount: amounts[0] ?? null,
      cadence: parseCadence(block),
      cadenceUnclear: cadenceUnclear(block),
      trial: parseTrial(block),
      tax: parseTaxDisplay(block),
      promo: !introSetAside && amounts.length > 0 && hasPromoWords(block),
    };
  });
}
