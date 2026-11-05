import type { PageSnapshot } from "../snapshot.js";

/** Page checks only judge a page that loaded: a 2xx response that is HTML (or says nothing). */
export function isHtmlPage(page: PageSnapshot): boolean {
  const type = page.hops.at(-1)?.headers["content-type"] ?? "text/html";
  return page.status >= 200 && page.status < 300 && /html/i.test(type);
}
