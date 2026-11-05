import type { Fetcher } from "./fetcher.js";
import type { Budget } from "./limits.js";
import { getOrNull } from "./probe.js";
import type { PageSnapshot } from "./snapshot.js";

/** A Sanity project and dataset, as named by an image or file address on cdn.sanity.io. */
export interface SanityRef {
  projectId: string;
  dataset: string;
}

/**
 * The only question asked: how many documents, and the distinct names of their types. Never a
 * document's contents. Asked without a token.
 */
export const SANITY_QUERY = '{"count": count(*), "types": array::unique(*[]._type)}';

/** The API version the query is asked at (array::unique needs v2021-03-25 or later). */
export const SANITY_API_VERSION = "v2021-10-21";

const CDN =
  /^https?:\/\/cdn\.sanity\.io\/(?:images|files)\/([a-z0-9]+)\/([a-z0-9][a-z0-9_-]{0,63})\//i;

/** Every distinct project and dataset the page's images (src, srcset, sources, og:image) name. */
export function sanityRefs(page: PageSnapshot): SanityRef[] {
  const urls: string[] = [];
  for (const img of page.images) {
    urls.push(img.src);
    for (const set of [img.srcset ?? "", ...(img.sources ?? []).map((s) => s.srcset)])
      for (const part of set.split(",")) urls.push(part.trim().split(/\s+/)[0] ?? "");
  }
  if (page.og["og:image"]) urls.push(page.og["og:image"]);
  const out = new Map<string, SanityRef>();
  for (const u of urls) {
    const m = CDN.exec(u);
    if (!m?.[1] || !m[2]) continue;
    const ref = { projectId: m[1].toLowerCase(), dataset: m[2] };
    out.set(`${ref.projectId}/${ref.dataset}`, ref);
  }
  return [...out.values()];
}

export function sanityQueryUrl(ref: SanityRef): string {
  return `https://${ref.projectId}.api.sanity.io/${SANITY_API_VERSION}/data/query/${encodeURIComponent(ref.dataset)}?query=${encodeURIComponent(SANITY_QUERY)}`;
}

/**
 * public: documents answered without a token. private: refused (401/403), or nothing visible.
 * unknown: no answer, or an answer that isn't the query's result.
 */
export interface DatasetRead extends SanityRef {
  url: string;
  state: "public" | "private" | "unknown";
  count?: number;
  types?: string[];
  status?: number;
}

export async function readDataset(fetcher: Fetcher, ref: SanityRef): Promise<DatasetRead> {
  const url = sanityQueryUrl(ref);
  const last = (await getOrNull(fetcher, url)).at(-1);
  if (!last) return { ...ref, url, state: "unknown" };
  const status = last.status;
  if (status === 401 || status === 403) return { ...ref, url, state: "private", status };
  if (status < 200 || status >= 300) return { ...ref, url, state: "unknown", status };
  try {
    const result = (
      JSON.parse(last.body ?? "") as { result?: { count?: unknown; types?: unknown } }
    ).result;
    const count = result?.count;
    const types = result?.types;
    if (typeof count !== "number" || !Array.isArray(types))
      return { ...ref, url, state: "unknown", status };
    const names = types.filter((t): t is string => typeof t === "string").sort();
    return { ...ref, url, status, count, types: names, state: count > 0 ? "public" : "private" };
  } catch {
    return { ...ref, url, state: "unknown", status };
  }
}

export interface DatasetOptions {
  page: PageSnapshot;
  fetcher: Fetcher;
  budget: Budget;
}

/** Read once on first use and shared by the dataset checks; at most LIMITS.sanityDatasets. */
export function lazyDatasets(opts: DatasetOptions): () => Promise<DatasetRead[]> {
  let pending: Promise<DatasetRead[]> | undefined;
  return () =>
    (pending ??= Promise.all(
      opts.budget
        .take("sanityDatasets", sanityRefs(opts.page))
        .map((r) => readDataset(opts.fetcher, r)),
    ));
}
