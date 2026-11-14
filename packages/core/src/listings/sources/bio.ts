import type { Connector } from "../../connectors/types.js";
import type { Listing } from "../types.js";

/**
 * Social platforms themselves. A bio is read through the link-in-bio address the owner gives, never
 * the profile page: Gaugeline does not request these hosts.
 */
const SOCIAL_HOSTS =
  /(^|\.)(instagram\.com|facebook\.com|fb\.com|fb\.me|tiktok\.com|x\.com|twitter\.com|threads\.net|linkedin\.com|youtube\.com|pinterest\.com)$/i;

/** True when the address is a social platform's own page. */
export function isSocialProfile(url: string): boolean {
  try {
    return SOCIAL_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface Bio {
  /** "Instagram", "Facebook": what the owner calls it. */
  name: string;
  /** The link-in-bio address the bio carries. */
  url: string;
}

/**
 * The link each social bio carries, as the owner configured it. There is nothing to read from a
 * platform: the connector states the link and the listings step opens it like any other website
 * link, to see whether it lands on the site.
 */
export function bioConnector(bios: readonly Bio[]): Connector<Listing> {
  return {
    id: "bio-link",
    envVars: [],
    configured: () => bios.length > 0,
    read: () =>
      Promise.resolve(
        bios.map((b): Listing => ({
          source: "bio-link",
          label: `${b.name} bio link`,
          status: "open",
          website: b.url,
        })),
      ),
  };
}
