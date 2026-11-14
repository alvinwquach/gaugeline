import { sanitise } from "../untrusted.js";
import type { ClickTarget } from "../events/observe.js";
import { shortUrl } from "./site-helpers.js";

/** How many links of one kind an evidence line names; the rest are counted. */
export const NAMED_LINKS = 3;

/**
 * A listed link as one phrase for an evidence line: its words (the site's own, so cleaned and cut) and where
 * it goes, with the site's own address shortened to its path. `note` is Gaugeline's, shown inside the brackets.
 */
export function linkName(target: ClickTarget, origin: string, note?: string): string {
  const words = sanitise(target.text, 60).text;
  const where = target.destination ? shortUrl(target.destination, origin) : undefined;
  const inside = [where === undefined ? undefined : sanitise(where, 120).text, note]
    .filter((x) => x !== undefined)
    .join(", ");
  return `"${words}"${inside === "" ? "" : ` (${inside})`}`;
}

/** The first few phrases, then how many more: bounded however many links there are. */
export function namedList(items: readonly string[]): string {
  const shown = items.slice(0, NAMED_LINKS).join(", ");
  return items.length > NAMED_LINKS ? `${shown} and ${items.length - NAMED_LINKS} more` : shown;
}

export const ordinal = (n: number): string => {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10] ?? "th"}`;
};
