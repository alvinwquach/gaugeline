import { collectPublished, describePartial } from "../adapters/collect.js";
import type { AdaptersConfig } from "../adapters/config.js";
import { adaptersOrDefault, type AdapterContext } from "../adapters/registry.js";
import {
  AdapterCouldNotCheck,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
} from "../adapters/types.js";
import type { Fetcher } from "../fetcher.js";
import { buildSnapshot } from "../snapshot.js";
import { differingFields } from "./compare.js";

/** What a run of --published uses when gaugeline.adapters.json has no `live` entry. */
export const PUBLISHED_DEFAULTS = Object.freeze({
  /** Items changed in the last this many days are compared with their pages. */
  days: 7,
  /** A page may lag its item by this many minutes before it is reported. */
  graceMinutes: 15,
  /** Pages asked for in one run, changed items first. */
  maxPages: 40,
  /** Items read when listing everything published, to find pages of items that are gone. */
  listCap: 2000,
});

/** The headers that say whether a cache served the page, and how old its copy is. In this order. */
export const CACHE_HEADERS = [
  "age",
  "last-modified",
  "cache-control",
  "x-vercel-cache",
  "x-nextjs-cache",
  "cf-cache-status",
] as const;

export type CacheHeaders = Partial<Record<(typeof CACHE_HEADERS)[number], string>>;

/** What the live address answered. */
export type PageOutcome =
  | { kind: "page"; status: number; headers: CacheHeaders; differing: string[] }
  | { kind: "missing"; status: number }
  | { kind: "unread"; reason: string };

/** One changed item and its page. `name` is the slug or the id: a label, never a field's value. */
export interface LiveItem {
  adapter: string;
  type: string;
  id: string;
  name: string;
  url: string;
  /** ISO 8601, from the content system. */
  updatedAt: string;
  /** The fields that were compared (their names). */
  compared: string[];
  outcome: PageOutcome;
}

/** A page that serves although no published item has its address. */
export interface StillLive {
  type: string;
  url: string;
  path: string;
  status: number;
  headers: CacheHeaders;
}

export interface PublishedReading {
  /** The origin of the site being checked. */
  site: string;
  /** The run's clock when the reading was made, ISO 8601. */
  now: string;
  days: number;
  graceMinutes: number;
  items: LiveItem[];
  stillLive: StillLive[];
  /** Why part of the reading is missing: a closed content system, a rate limit, a budget. Each is could-not-check. */
  notes: string[];
}

/**
 * What the published-not-live checks read, once for the site and shared: the items each content system says
 * changed lately, and one GET of the live page of each, through the fetcher. The checks run on every page of
 * a run, so `claim` lets only the first of them report each kind of finding.
 */
export interface Published {
  read(site: string, now: Date): Promise<PublishedReading>;
  claim(checkId: string, site: string): boolean;
}

const MINUTE = 60_000;
/** Items read for the changed-lately list. More than the page budget, so the report can say how many were left out. */
const RECENT_CAP = 500;

const bare = (host: string): string => host.toLowerCase().replace(/^www\./, "");
const pathKey = (url: URL): string => url.pathname.replace(/\/+$/, "") || "/";

function onSite(raw: string, origin: string): URL | undefined {
  if (raw === "") return undefined;
  try {
    const url = new URL(raw, origin);
    return bare(url.host) === bare(new URL(origin).host) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** A template ("/menu/{slug}") as a pattern over a path. */
function templatePattern(template: string): RegExp {
  const path = template.replace(/^https:\/\/[^/]+/, "");
  const source = path
    .split(/(\{slug\}|\{id\})/)
    .map((part) =>
      part === "{slug}" || part === "{id}" ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source.replace(/\/+$/, "")}/?$`);
}

function pick(headers: Readonly<Record<string, string>>): CacheHeaders {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: CacheHeaders = {};
  for (const name of CACHE_HEADERS) {
    const v = lower.get(name);
    if (v !== undefined && v !== "") out[name] = v.slice(0, 200);
  }
  return out;
}

type Asked =
  | {
      kind: "page";
      status: number;
      headers: CacheHeaders;
      hops: Parameters<typeof buildSnapshot>[0];
    }
  | { kind: "missing"; status: number }
  | { kind: "unread"; reason: string };

/** One page, asked with GET through the fetcher: a 2xx is there, 404 and 410 are gone, anything else is not an answer. */
async function ask(fetcher: Fetcher, url: string, origin: string): Promise<Asked> {
  try {
    const hops = await fetcher.get(url);
    const last = hops.at(-1);
    if (!last) return { kind: "unread", reason: "no answer" };
    const final = onSite(last.url, origin);
    if (final === undefined)
      return { kind: "unread", reason: "the address redirects to another site" };
    if (last.status >= 200 && last.status < 300)
      return { kind: "page", status: last.status, headers: pick(last.headers), hops };
    if (last.status === 404 || last.status === 410) return { kind: "missing", status: last.status };
    return { kind: "unread", reason: `the site answered ${last.status}` };
  } catch (err) {
    return { kind: "unread", reason: err instanceof Error ? err.message : String(err) };
  }
}

interface Source {
  adapter: ContentAdapter;
  settings: AdapterSettings | undefined;
  /** A page reader (the sitemap and feed adapter, Framer): it lists the site's own pages, not a content system. */
  pages: boolean;
}

interface Todo {
  adapter: string;
  type: string;
  id: string;
  name: string;
  url: URL;
  updatedAt: string;
  doc: PublishedDoc;
}

export function createPublished(
  config: AdaptersConfig | undefined,
  context: Omit<AdapterContext, "site">,
  fetcher: Fetcher,
  /** Replaces the adapters the settings name. For tests, which read recorded content. */
  build?: (origin: string) => ContentAdapter[],
): Published {
  const live = config?.live ?? {};
  const days = live.days ?? PUBLISHED_DEFAULTS.days;
  const graceMinutes = live.graceMinutes ?? PUBLISHED_DEFAULTS.graceMinutes;
  const budget = live.maxPages ?? PUBLISHED_DEFAULTS.maxPages;
  const reads = new Map<string, Promise<PublishedReading>>();
  const claimed = new Set<string>();

  async function fieldsFor(s: Source): Promise<Record<string, readonly string[]> | undefined> {
    let names: string[] = [];
    try {
      names = (await s.adapter.types()).map((t) => t.name);
    } catch {
      // types the platform would not list: only what the settings name is compared
    }
    const out: Record<string, readonly string[]> = {};
    for (const t of names) out[t] = live.fields?.[t] ?? s.settings?.fingerprint?.[t] ?? ["title"];
    for (const [t, f] of Object.entries(live.fields ?? {})) out[t] = f;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function read(site: string, now: Date): Promise<PublishedReading> {
    const origin = new URL(site).origin;
    const since = new Date(now.getTime() - days * 24 * 60 * MINUTE).toISOString();
    const reading: PublishedReading = {
      site: origin,
      now: now.toISOString(),
      days,
      graceMinutes,
      items: [],
      stillLive: [],
      notes: [],
    };
    const adapters =
      build?.(origin) ?? (await adaptersOrDefault(config, { ...context, site: origin }));
    if (adapters.length === 0) {
      reading.notes.push(
        "There is no content system to read: give a site address, or name an adapter in gaugeline.adapters.json.",
      );
      return reading;
    }
    const sources: Source[] = adapters.map((adapter, i) => ({
      adapter,
      settings: config?.adapters[i],
      pages: adapter.describe().noKey === true || adapter.readsPages === true,
    }));

    const todo: Todo[] = [];
    const siteUrls: URL[] = [];
    let unaddressed = 0;
    let undated = 0;

    for (const s of sources) {
      const id = s.adapter.id;
      try {
        const fields = s.pages ? undefined : await fieldsFor(s);
        const got = await collectPublished(
          s.adapter,
          s.pages
            ? { limit: PUBLISHED_DEFAULTS.listCap }
            : { since, limit: RECENT_CAP, ...(fields ? { fields } : {}) },
        );
        if (got.partial) reading.notes.push(`${id}: ${describePartial(got.partial)}`);
        for (const d of got.docs) {
          const resolved = d.url ?? s.adapter.resolveUrl?.(d) ?? "";
          const url = onSite(resolved, origin);
          if (s.pages && url !== undefined) siteUrls.push(url);
          if (d.updatedAt === undefined) {
            undated++;
            continue;
          }
          if (Date.parse(d.updatedAt) < Date.parse(since)) continue;
          if (url === undefined) {
            unaddressed++;
            continue;
          }
          todo.push({
            adapter: id,
            type: d.type,
            id: d.id,
            name: d.slug ?? d.id,
            url,
            updatedAt: d.updatedAt,
            doc: d,
          });
        }
      } catch (err) {
        if (!(err instanceof AdapterCouldNotCheck)) throw err;
        reading.notes.push(`${id}: ${err.reason}`);
      }
    }

    // Pages of items the content system no longer lists: an address that fits an item pattern, is in the
    // site's own sitemap, and that no published item has. Only possible with a list of the whole site.
    const candidates: { type: string; url: URL }[] = [];
    if (siteUrls.length > 0) {
      for (const s of sources) {
        const templates = Object.entries(s.settings?.urls ?? {});
        if (s.pages || templates.length === 0) continue;
        try {
          const all = await collectPublished(s.adapter, { limit: PUBLISHED_DEFAULTS.listCap });
          if (all.partial || all.docs.length >= PUBLISHED_DEFAULTS.listCap) {
            reading.notes.push(
              `${s.adapter.id}: the list of everything published was cut short, so pages of unpublished items were not looked for.`,
            );
            continue;
          }
          const have = new Set<string>();
          for (const d of all.docs) {
            const u = onSite(d.url ?? s.adapter.resolveUrl?.(d) ?? "", origin);
            if (u !== undefined) have.add(pathKey(u));
          }
          for (const [type, template] of templates) {
            const pattern = templatePattern(template);
            for (const u of siteUrls)
              if (pattern.test(u.pathname) && !have.has(pathKey(u)))
                candidates.push({ type, url: u });
          }
        } catch (err) {
          if (!(err instanceof AdapterCouldNotCheck)) throw err;
          reading.notes.push(`${s.adapter.id}: ${err.reason}`);
        }
      }
    }

    // Changed items first (newest first), then the unlisted pages; both in a fixed order.
    todo.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const seen = new Set<string>();
    const uniqueCandidates = candidates
      .filter((c) => !todo.some((t) => pathKey(t.url) === pathKey(c.url)))
      .filter((c) => !seen.has(pathKey(c.url)) && seen.add(pathKey(c.url)))
      .sort((a, b) => a.url.pathname.localeCompare(b.url.pathname));

    const asked = todo.slice(0, budget);
    const askedCandidates = uniqueCandidates.slice(0, Math.max(0, budget - asked.length));
    const left = todo.length - asked.length + (uniqueCandidates.length - askedCandidates.length);
    if (left > 0)
      reading.notes.push(
        `${left} ${left === 1 ? "page was" : "pages were"} not asked for: at most ${budget} are asked for in one run (live.maxPages in gaugeline.adapters.json).`,
      );
    if (unaddressed > 0)
      reading.notes.push(
        `${unaddressed} changed ${unaddressed === 1 ? "item has" : "items have"} no address on this site, so ${unaddressed === 1 ? "its page was" : "their pages were"} not looked for (give "urls" for the type in gaugeline.adapters.json).`,
      );
    if (undated > 0 && sources.some((s) => !s.pages))
      reading.notes.push(
        `${undated} ${undated === 1 ? "item has" : "items have"} no update time, so it cannot be told whether ${undated === 1 ? "it" : "they"} changed lately.`,
      );

    reading.items = await Promise.all(
      asked.map(async (t): Promise<LiveItem> => {
        const answer = await ask(fetcher, t.url.href, origin);
        const compared = Object.keys(t.doc.fieldHashes).sort();
        let outcome: PageOutcome;
        if (answer.kind === "page") {
          const snap = buildSnapshot(answer.hops);
          outcome = {
            kind: "page",
            status: answer.status,
            headers: answer.headers,
            differing: differingFields(t.doc.fieldHashes, compared, snap),
          };
        } else outcome = answer;
        return {
          adapter: t.adapter,
          type: t.type,
          id: t.id,
          name: t.name,
          url: t.url.href,
          updatedAt: t.updatedAt,
          compared,
          outcome,
        };
      }),
    );
    const answers = await Promise.all(
      askedCandidates.map(async (c) => ({ c, answer: await ask(fetcher, c.url.href, origin) })),
    );
    for (const { c, answer } of answers) {
      if (answer.kind === "page")
        reading.stillLive.push({
          type: c.type,
          url: c.url.href,
          path: c.url.pathname,
          status: answer.status,
          headers: answer.headers,
        });
      else if (answer.kind === "unread") reading.notes.push(`${c.url.pathname}: ${answer.reason}`);
    }
    return reading;
  }

  return {
    read(site, now) {
      const key = new URL(site).origin;
      let p = reads.get(key);
      if (!p) reads.set(key, (p = read(site, now)));
      return p;
    },
    claim(checkId, site) {
      const key = `${checkId} ${new URL(site).origin}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
}
