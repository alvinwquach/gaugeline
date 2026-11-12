/**
 * What marks an address as Adobe Experience Manager's AUTHOR tier (the editors' side), as plain pure
 * functions with no I/O. The adapter uses it to refuse an author address as the publish address; the
 * `aem-author-links` check uses it on the links a page already serves. Nothing here asks for anything.
 *
 * Shapes (uncited, from the usual AEM layouts and Adobe's Cloud Service host names; Adobe's docs were not
 * reachable when this was written): the author host is `author.<domain>` on a self-hosted install and
 * `author-p<program>-e<environment>.adobeaemcloud.com` on AEM as a Cloud Service; the editors' paths are
 * `/editor.html/...`, `/ui#/aem/...`, `/crx/...` and `/libs/...`.
 */

/** A hostname (lower case) that is an author host. Linear: one split, two bounded tests. */
export function isAuthorHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const first = host.split(".", 1)[0] ?? "";
  if (first === "author" && host.length > "author.".length) return true;
  return /^author-p\d{1,10}-e\d{1,10}\.adobeaemcloud\.com$/.test(host);
}

/** The editors' paths. `ui` is matched with its hash (`/ui#/aem`), because the app lives in the fragment. */
function editorPath(pathname: string, hash: string): string | undefined {
  const path = pathname.toLowerCase();
  const under = (prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
  if (path === "/editor.html" || path.startsWith("/editor.html/")) return "/editor.html";
  if (path === "/ui" && hash.toLowerCase().startsWith("#/aem")) return "/ui#/aem";
  if (under("/crx")) return "/crx/";
  if (under("/libs")) return "/libs/";
  return undefined;
}

/**
 * Why a link is to the author tier, or undefined when it is not. `pageHost` is the host of the page that
 * carries the link. An author host counts for any path. An editors' path counts only on the page's own
 * host, so another site's `/editor.html` is never taken for this one's. The address must be absolute.
 */
export function authorTierLink(href: string, pageHost: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (isAuthorHost(url.hostname)) return "an author host";
  if (url.hostname.toLowerCase() === pageHost.toLowerCase())
    return editorPath(url.pathname, url.hash);
  return undefined;
}
