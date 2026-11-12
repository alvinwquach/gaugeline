import { isQwikSite } from "../qwik/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { isSolidStartSite } from "../solidstart/detect.js";

export type Framework = "qwik" | "solidstart";

/** Which of the two the page is, from its own markup; undefined when neither. */
export function frameworkOf(page: PageSnapshot): Framework | undefined {
  if (isQwikSite(page)) return "qwik";
  if (isSolidStartSite(page)) return "solidstart";
  return undefined;
}

/** "name, name, and N more": names only, so evidence stays one line. */
export const names = (list: readonly string[]): string =>
  list.slice(0, 8).join(", ") + (list.length > 8 ? `, and ${list.length - 8} more` : "");
