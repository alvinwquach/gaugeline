import { FetchError, type Fetcher, type Hop } from "../fetcher.js";
import { NetworkError } from "../errors.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import type { ContentNow } from "./compare.js";
import { buildContentSnapshot, contentKey, type ContentSnapshot } from "./page-snapshot.js";

export interface ContentNowOptions {
  /** The last run's pages, by contentKey. */
  previous: Readonly<Record<string, ContentSnapshot>>;
  /** The pages this run reads anyway (the checked page and its sample). */
  pages: () => Promise<PageSnapshot[]>;
  fetcher: Fetcher;
  /** The checked page's origin: a saved path is requested here. */
  origin: string;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const html = (h: Hop | undefined) => /html/i.test(h?.headers["content-type"] ?? "text/html");

/** What one requested trail says the page is now. */
export function readNow(hops: readonly Hop[], key: string): ContentNow {
  const first = hops[0];
  const last = hops.at(-1);
  if (!first || !last) return { kind: "unread", reason: "no answer" };
  if (first.status === 404 || first.status === 410) return { kind: "gone", status: first.status };
  if (REDIRECT.has(first.status)) {
    const end = REDIRECT.has(last.status) ? (last.headers.location ?? last.url) : last.url;
    let to: URL | undefined;
    try {
      to = new URL(end, last.url);
    } catch {
      to = undefined;
    }
    if (to && contentKey(to.href) !== key) {
      const leadsTo = to.origin === new URL(first.url).origin ? to.pathname : to.href;
      return { kind: "gone", status: first.status, leadsTo };
    }
  }
  if (last.status === 404 || last.status === 410) return { kind: "gone", status: last.status };
  if (last.status >= 200 && last.status < 300 && html(last))
    return { kind: "page", snap: buildContentSnapshot(buildSnapshot([...hops])) };
  return { kind: "unread", reason: `answered ${last.status}` };
}

/**
 * Each saved page as it is now, read once on first use: from the pages this run read anyway when
 * one was requested at that path, else one GET through the fetcher.
 */
export function lazyContentNow(opts: ContentNowOptions): () => Promise<Map<string, ContentNow>> {
  let pending: Promise<Map<string, ContentNow>> | undefined;
  const run = async () => {
    const read = new Map<string, PageSnapshot>();
    for (const p of await opts.pages()) read.set(contentKey(p.requestedUrl), p);
    const out = new Map<string, ContentNow>();
    for (const key of Object.keys(opts.previous).sort()) {
      const known = read.get(key);
      if (known) {
        out.set(key, readNow(known.hops, key));
        continue;
      }
      let hops: Hop[];
      try {
        hops = await opts.fetcher.get(new URL(key, opts.origin).href);
      } catch (err) {
        if (err instanceof FetchError && err.hops.length > 0) hops = err.hops;
        else if (err instanceof NetworkError) {
          out.set(key, { kind: "unread", reason: err.message });
          continue;
        } else throw err;
      }
      out.set(key, readNow(hops, key));
    }
    return out;
  };
  return () => (pending ??= run());
}
