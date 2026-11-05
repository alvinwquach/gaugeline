import { NetworkError } from "./errors.js";
import type { Fetcher, Hop } from "./fetcher.js";

/** Every hop of a GET (or HEAD), or [] when the address could not be reached at all. */
export async function getOrNull(fetcher: Fetcher, url: string, method?: "HEAD"): Promise<Hop[]> {
  try {
    return await fetcher.get(url, method ? { method } : undefined);
  } catch (err) {
    if (err instanceof NetworkError) return [];
    throw err;
  }
}

/**
 * HEAD first, the polite request; a server that refuses HEAD (405 Method Not Allowed or 501 Not
 * Implemented) is asked again with GET. [] when the address could not be reached.
 */
export async function probe(url: string, fetcher: Fetcher): Promise<Hop[]> {
  const head = await getOrNull(fetcher, url, "HEAD");
  const status = head.at(-1)?.status;
  if (status === 405 || status === 501) return getOrNull(fetcher, url);
  return head;
}
