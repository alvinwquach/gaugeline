import { addressParts } from "../facts/business.js";

/**
 * "The BUCK Tavern" and "Buck Tavern, The" are one name: case, accents, punctuation and a leading
 * or trailing "The" are ignored.
 */
export function normaliseName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
  if (words[0] === "the") words.shift();
  if (words.at(-1) === "the") words.pop();
  return words.join(" ");
}

/**
 * The same name, or one that adds words around it (a listing that reads "BUCK Tavern - Eastside").
 * A single word is never matched inside a longer name, and "Buckhorn" is not "Buck".
 */
export function namesAgree(a: string, b: string): boolean {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (x === "" || y === "") return true;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.includes(" ") && ` ${long} `.includes(` ${short} `);
}

/**
 * Whether two addresses agree on what both state: the house number and the 5-digit ZIP. Street
 * names are not compared (St, Street and Str. are all spellings), so a wrong street with the right
 * number and ZIP passes. Undefined when the two share nothing comparable.
 */
export function addressesAgree(a: string, b: string): boolean | undefined {
  const x = addressParts(a);
  const y = addressParts(b);
  const compared: boolean[] = [];
  if (x.streetNumber && y.streetNumber) compared.push(x.streetNumber === y.streetNumber);
  if (x.zip && y.zip) compared.push(x.zip === y.zip);
  return compared.length === 0 ? undefined : compared.every(Boolean);
}

/** The host of an address, lower case, without "www.". Undefined when it is not an address. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function sameHost(a: string, b: string): boolean {
  const x = hostOf(a);
  return x !== undefined && x === hostOf(b);
}

/** What opening a listing's link found. */
export interface LinkResolution {
  status?: number;
  finalUrl?: string;
  /** Redirects followed before the answer. */
  redirects: number;
  /** Why it could not be opened, when it could not. */
  error?: string;
  /** Link-in-bio pages only: the hosts the page links to. */
  linkHosts?: string[];
}

/** A chain is three redirects or more: http to https to www is two and is normal. */
export const CHAIN_AT = 3;

/**
 * What is wrong with the link a listing carries, or undefined when it is fine. A link to another
 * host is wrong even when it redirects to the site: the listing should not depend on a redirect
 * that can lapse with the old domain.
 */
export function websiteProblem(
  listed: string,
  found: LinkResolution,
  siteHost: string,
): string | undefined {
  if (found.error !== undefined) return `${listed} could not be opened (${found.error})`;
  if (found.status !== undefined && found.status >= 400) return `${listed} answers ${found.status}`;
  const final = found.finalUrl ?? listed;
  const finalHost = hostOf(final);
  if (found.linkHosts !== undefined) {
    // A link-in-bio page: it resolves to the site if it lands there or links there.
    return finalHost === siteHost || found.linkHosts.includes(siteHost)
      ? undefined
      : `the link-in-bio page ${final} does not link to ${siteHost}`;
  }
  const listedHost = hostOf(listed);
  if (listedHost !== undefined && listedHost !== siteHost) {
    return finalHost === siteHost
      ? `the listing links to ${listedHost}, which redirects to ${siteHost}`
      : `the listing links to ${listedHost}, not ${siteHost}`;
  }
  if (found.redirects >= CHAIN_AT)
    return `${listed} goes through ${found.redirects} redirects to reach ${final}`;
  return undefined;
}
