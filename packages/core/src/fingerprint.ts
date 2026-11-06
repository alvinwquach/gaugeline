import { createHash } from "node:crypto";
import type { Finding } from "./model.js";
import { addressKey } from "./plan/keys.js";

/**
 * The one fingerprint in core: what makes a finding "the same finding" from one run to the next.
 * sha256 of the check id, the path (normalised with addressKey, host removed) and a stable key,
 * first 16 hex characters. A plan finding's key is its group key (a path, a title, a keyword),
 * never its evidence, which holds counts;
 * any other finding's key is its evidence with addresses' hosts and every number taken out, so a
 * new preview host, a count or a timing doesn't make it new. Baselines (G29) use the same function.
 */
export function fingerprint(f: Pick<Finding, "checkId" | "url" | "evidence" | "group">): string {
  return createHash("sha256")
    .update(`${f.checkId}\n${pathOf(f.url)}\n${stableKey(f)}`)
    .digest("hex")
    .slice(0, 16);
}

/** The path of an absolute address, lower case, no trailing slash, no host; "" for a file name. */
function pathOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const key = addressKey({
    url: u.href,
    path: u.pathname,
    ...(u.hash ? { fragment: u.hash.slice(1) } : {}),
  });
  return key.slice(key.indexOf("/"));
}

/** Hosts out of every address, then every number out: what is left names the problem. */
export function stableEvidence(text: string): string {
  return text
    .replace(/\bhttps?:\/\/[^/\s"'<>]+/gi, "")
    .replace(/\d+(?:[.,]\d+)*/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A group key is stable already (a path, a title): kept as it is, digits and all, in lower case. */
function stableKey(f: Pick<Finding, "evidence" | "group">): string {
  if (f.group) return f.group.key.replace(/\s+/g, " ").trim().toLowerCase();
  return stableEvidence(f.evidence);
}
