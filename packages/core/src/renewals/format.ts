import { expiryPhrase } from "./dates.js";
import type { RenewalRow } from "./reader.js";

const LEVEL: Readonly<Record<RenewalRow["level"], string>> = {
  first: "Fix first",
  soon: "Fix soon",
  fine: "OK",
  unknown: "-",
};

const KIND: Readonly<Record<RenewalRow["kind"], string>> = {
  domain: "Domain ",
  certificate: "Certificate for ",
  token: "",
  runtime: "",
};

/**
 * The Renewals list as lines of text, in the order given (soonest first): the level, what lapses and
 * when, with the date written out ("expires 3 Dec 2026, 24 days"). A row with no date says why it has
 * none ("no expiry reported"). Pure: the same rows and clock give the same lines.
 */
export function formatRenewalRows(rows: readonly RenewalRow[], now: Date): string[] {
  const width = Math.max(0, ...rows.map((r) => LEVEL[r.level].length));
  return rows.map((r) => {
    const when = r.date
      ? expiryPhrase(r.date, now, r.kind === "runtime" ? ["retires", "retired"] : undefined)
      : "";
    const text = [when, r.note].filter((t): t is string => t !== undefined && t !== "");
    return `${LEVEL[r.level].padEnd(width)}  ${KIND[r.kind]}${r.subject}${text.length > 0 ? `: ${text.join("; ")}` : ""}`;
  });
}
