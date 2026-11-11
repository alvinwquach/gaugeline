import { NetworkError } from "../errors.js";
import { FetchError } from "../fetcher.js";
import type { CheckContext } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  pageDataAddress,
  readPageData,
  readStaticQuery,
  staticQueryAddress,
  type DataRead,
} from "./detect.js";

/** A refusal to answer, or an error, is never a finding: it is the reason a read could not be made. */
async function ask(
  ctx: CheckContext,
  url: string,
): Promise<{ status: number; body: string; truncated: boolean } | string> {
  if (!ctx.fetcher) return "no fetcher";
  try {
    const last = (await ctx.fetcher.get(url)).at(-1);
    if (!last) return "no answer";
    return { status: last.status, body: last.body ?? "", truncated: last.truncated === true };
  } catch (err) {
    if (err instanceof FetchError && err.hops.length > 0)
      return `answered ${err.hops.at(-1)?.status ?? 0}`;
    if (err instanceof NetworkError) return err.message;
    throw err;
  }
}

async function read(
  ctx: CheckContext,
  url: string,
  parse: (text: string, truncated: boolean) => DataRead,
): Promise<DataRead> {
  const a = await ask(ctx, url);
  if (typeof a === "string") return { unread: `the data address could not be read: ${a}` };
  if (a.status < 200 || a.status >= 300) return { unread: `the data address answered ${a.status}` };
  return parse(a.body, a.truncated);
}

export interface DataFile {
  url: string;
  read: DataRead;
}
const cache = new WeakMap<PageSnapshot, Promise<DataFile[]>>();

/**
 * The page's own data and the static queries it lists: the files the framework's client asks for
 * when a visitor opens the page. Asked for once and shared by the checks that read them. The first
 * entry is the page's data; the others are its static queries, at most ten.
 */
export function pageFiles(page: PageSnapshot, ctx: CheckContext): Promise<DataFile[]> {
  const hit = cache.get(page);
  if (hit) return hit;
  const run = async (): Promise<DataFile[]> => {
    const url = pageDataAddress(page);
    const main = await read(ctx, url, readPageData);
    const files: DataFile[] = [{ url, read: main }];
    if ("unread" in main) return files;
    for (const hash of main.hashes) {
      const sq = staticQueryAddress(url, hash);
      files.push({ url: sq, read: await read(ctx, sq, readStaticQuery) });
    }
    return files;
  };
  const p = run();
  cache.set(page, p);
  return p;
}
