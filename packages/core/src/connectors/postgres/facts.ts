import { toMinor } from "../../products/money.js";
import type { Fact } from "../../facts/types.js";
import type { FactMapping } from "./config.js";
import type { DatabaseQueryResult } from "./connector.js";
import type { Cell } from "./session.js";

function text(v: Cell | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** Whole minor units as "$12.50". */
function formatMinor(minor: number, currency: string): string {
  const whole = Math.trunc(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  return `${currency}${whole}.${cents}`;
}

export interface MappedFacts {
  facts: Fact[];
  /** Rows that could not become a fact (a missing column, a price that is not a plain amount). */
  skipped: number;
}

/**
 * The rows of a query as facts in the X23 model, so the checks that compare a page with declared
 * facts can read a database the same way they read gaugeline.facts.json. A price is kept as whole
 * cents until it is written out. No check reads these yet (data assertions and the switches check
 * do); this only maps.
 */
export function factsFromResult(result: DatabaseQueryResult, mapping: FactMapping): MappedFacts {
  const facts: Fact[] = [];
  let skipped = 0;
  result.rows.forEach((row, i) => {
    const id = `${result.source}.${result.query}.${i + 1}`;
    const where = mapping.mustAppearOn ? { mustAppearOn: mapping.mustAppearOn } : {};
    if (mapping.kind === "text") {
      const value = text(row[mapping.value]);
      if (value === undefined) skipped++;
      else facts.push({ id, kind: "text", value, ...where });
      return;
    }
    const item = text(row[mapping.item]);
    const raw = text(row[mapping.value]);
    if (item === undefined || raw === undefined) {
      skipped++;
      return;
    }
    try {
      const minor = mapping.unit === "minor" ? parseMinor(raw) : toMinor(raw);
      facts.push({
        id,
        kind: "price",
        item,
        value: formatMinor(minor, mapping.currency),
        ...where,
      });
    } catch {
      skipped++;
    }
  });
  return { facts, skipped };
}

function parseMinor(raw: string): number {
  if (!/^\d{1,15}$/.test(raw)) throw new RangeError("not whole cents");
  return Number(raw);
}
