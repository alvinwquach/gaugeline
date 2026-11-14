import { registrableOf } from "../renewals/suffix.js";

/**
 * Which site an address belongs to, for refusing scripts from "another site" (PERF-02). The site is the registrable
 * domain: the name below a public suffix, so `cdn.site.co.uk` and `www.site.co.uk` are one site and `evil.co.uk` is
 * not another's; each tenant of a hosting platform is its own site; an address written as numbers, and a name with
 * no dot, are their own site by their whole host. A trailing dot, case, scheme and port do not matter.
 */
export function siteKey(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (host === "") return undefined;
  const r = registrableOf(host);
  if (r.kind === "domain") return r.domain;
  if (r.kind === "platform") {
    // The tenant is the label just before the platform's own name: `cdn.shop.gitlab.io` is `shop.gitlab.io`.
    const tenant = host
      .slice(0, host.length - r.platform.length - 1)
      .split(".")
      .at(-1);
    return `${tenant}.${r.platform}`;
  }
  return host;
}

/**
 * Whether a script comes from another site than the page. Fails closed: an address that cannot be read, or is not
 * a web address, counts as another site, because the variant that asks refuses scripts and a wrong "same site"
 * would let one through.
 */
export function isThirdParty(scriptUrl: string, pageUrl: string): boolean {
  const script = siteKey(scriptUrl);
  const page = siteKey(pageUrl);
  return script === undefined || page === undefined || script !== page;
}
