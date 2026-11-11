import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import list from "../data/public-suffixes.json";

const SUFFIXES: ReadonlySet<string> = new Set(list.suffixes);
const PLATFORMS: readonly string[] = list.platforms;

/** What a host's registration is, for the domain checks. */
export type Registrable =
  /** The name a registry sells: `tld` is its last label (the registry's own RDAP server is asked for it). */
  | { kind: "domain"; domain: string; tld: string }
  /** A subdomain of a hosting platform (marlowe.vercel.app): the platform owns the name, not the client. */
  | { kind: "platform"; host: string; platform: string }
  | { kind: "none"; reason: string };

/**
 * The registrable domain of a host: the name below a public suffix. A Set of the multi-label suffixes
 * in data/public-suffixes.json (co.uk, com.au) decides how many labels to keep; everything else is
 * taken as a one-label suffix. A leading www is dropped. Pure, no lookup.
 */
export function registrableOf(host: string): Registrable {
  const raw = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (raw === "") return { kind: "none", reason: "there is no host name to look up" };
  if (isIP(raw) !== 0)
    return { kind: "none", reason: "an IP address has no domain registration to look up" };
  const ascii = domainToASCII(raw.toLowerCase());
  const labels = ascii.replace(/^www\./, "").split(".");
  if (ascii === "" || labels.length < 2)
    return { kind: "none", reason: `${raw} is not a registrable domain name` };
  const name = labels.join(".");
  const platform = PLATFORMS.find((p) => name.endsWith(`.${p}`));
  if (platform !== undefined) return { kind: "platform", host: name, platform };
  const last2 = labels.slice(-2).join(".");
  const keep = SUFFIXES.has(last2) ? 3 : 2;
  if (labels.length < keep)
    return { kind: "none", reason: `${name} is a public suffix, not a domain` };
  return {
    kind: "domain",
    domain: labels.slice(-keep).join("."),
    tld: labels[labels.length - 1] ?? "",
  };
}
