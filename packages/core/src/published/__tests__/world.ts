import { Readable } from "node:stream";
import { hashValue } from "../../adapters/fingerprint.js";
import {
  AdapterCouldNotCheck,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
} from "../../adapters/types.js";
import { fillUrlTemplate } from "../../adapters/fingerprint.js";
import type { AdaptersConfig } from "../../adapters/config.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { page } from "../../checks/__tests__/helpers.js";
import { createPublished, type Published } from "../reader.js";

/** An invented bar: the owner publishes a new menu and the site keeps showing the old one. */
export const SITE = "https://lantern-ladle.example";
export const NOW = new Date("2026-11-11T12:00:00.000Z");

export const minutesBefore = (minutes: number): string =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

export const MENU_URLS = { menu: "/menu/{slug}" };

export interface Item {
  slug: string;
  /** The title as the content system has it. */
  title: string;
  minutesAgo: number;
  /** An address, when the platform gives one. */
  url?: string;
}

/** A content system that answers from a list: counts and fingerprints, never a title. */
export function fakeCms(
  items: readonly Item[],
  options: { id?: string; failWith?: string; type?: string } = {},
): ContentAdapter {
  const type = options.type ?? "menu";
  const docs = (): PublishedDoc[] =>
    items.map((i) => ({
      id: `id-${i.slug}`,
      type,
      slug: i.slug,
      ...(i.url !== undefined ? { url: i.url } : {}),
      updatedAt: minutesBefore(i.minutesAgo),
      fieldHashes: { title: hashValue(i.title) ?? "" },
    }));
  return {
    id: options.id ?? "fake-cms",
    describe: () => ({ name: "Fake", docsUrl: "https://example.test/docs", keyKind: "read-only" }),
    types: () => Promise.resolve([{ name: type, count: items.length }]),
    fieldCounts: () => Promise.resolve({}),

    async *published(opts: PublishedOptions = {}) {
      if (options.failWith) throw new AdapterCouldNotCheck(options.failWith);
      for (const d of docs()) {
        if (opts.since !== undefined && (d.updatedAt ?? "") < opts.since) continue;
        yield d;
      }
    },
    draftsReachable: () => Promise.resolve(true),
    resolveUrl: (d) => fillUrlTemplate(MENU_URLS.menu, d),
  };
}

/** A page reader: the addresses a sitemap lists, with a date or none. */
export function fakeSitemap(paths: readonly string[]): ContentAdapter {
  return {
    id: "sitemap-feed",
    describe: () => ({
      name: "Sitemap",
      docsUrl: "https://example.test/docs",
      keyKind: "read-only",
      noKey: true,
    }),
    types: () => Promise.resolve([{ name: "page", count: paths.length }]),
    fieldCounts: () => Promise.resolve({}),

    async *published() {
      for (const p of paths)
        yield { id: `${SITE}${p}`, type: "page", url: `${SITE}${p}`, fieldHashes: {} };
    },
    draftsReachable: () => Promise.resolve("not-applicable" as const),
    resolveUrl: (d) => d.id,
  };
}

export interface FixturePage {
  status: number;
  title?: string;
  h1?: string;
  headers?: Record<string, string>;
}

const html = (p: FixturePage): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${p.title ?? ""}</title></head><body><h1>${p.h1 ?? p.title ?? ""}</h1></body></html>`;

/** The bar's site: a page per path, and every request recorded. */
export function barSite(pages: Readonly<Record<string, FixturePage>>): {
  fetcher: Fetcher;
  seen: string[];
} {
  const seen: string[] = [];
  const transport: Transport = (url, req) => {
    seen.push(`${req.method} ${url.pathname}`);
    const p = pages[url.pathname];
    if (!p) return Promise.resolve({ status: 404, headers: {}, body: Readable.from([]) });
    return Promise.resolve({
      status: p.status,
      headers: { "content-type": "text/html", ...p.headers },
      body: Readable.from(req.method === "HEAD" ? [] : [Buffer.from(html(p))]),
    });
  };
  return { fetcher: createFetcher({ transport, timeoutMs: 5000 }), seen };
}

export function reader(
  adapters: readonly ContentAdapter[],
  fetcher: Fetcher,
  live: NonNullable<AdaptersConfig["live"]> = {},
): Published {
  const config: AdaptersConfig = {
    adapters: adapters.map((a) => ({
      id: a.id,
      ...(a.id === "sitemap-feed" ? {} : { urls: MENU_URLS }),
    })),
    live,
  };
  return createPublished(config, { env: {}, fetcher }, fetcher, () => [...adapters]);
}

export function context(published?: Published) {
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    now: () => NOW,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(published ? { published } : {}),
  };
  return { ctx, notes };
}

export const homePage = (path = "/") => page({ finalUrl: `${SITE}${path}` });
