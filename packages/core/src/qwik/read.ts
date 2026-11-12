import { NetworkError } from "../errors.js";
import { FetchError } from "../fetcher.js";
import type { CheckContext } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { qDataAddress, readQData, type NamesRead } from "./detect.js";

const type = (headers: Record<string, string>): string =>
  (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

/** One GET through the fetcher; a string is the reason it could not be read. Never a finding. */
async function ask(
  ctx: CheckContext,
  url: string,
  headers?: Record<string, string>,
): Promise<
  { status: number; headers: Record<string, string>; body: string; truncated: boolean } | string
> {
  if (!ctx.fetcher) return "no fetcher";
  try {
    const hops = await ctx.fetcher.get(url, headers ? { headers, headersSameOrigin: true } : {});
    const last = hops.at(-1);
    if (!last) return "no answer";
    return {
      status: last.status,
      headers: last.headers,
      body: last.body ?? "",
      truncated: last.truncated === true,
    };
  } catch (err) {
    if (err instanceof FetchError && err.hops.length > 0)
      return `answered ${err.hops.at(-1)?.status ?? 0}`;
    if (err instanceof NetworkError) return err.message;
    throw err;
  }
}

export interface QDataResult {
  url: string;
  read: NamesRead;
}
const qDataCache = new WeakMap<PageSnapshot, Promise<QDataResult>>();

/** The page's own `q-data.json` (the answer Qwik City's client asks for on every navigation), once. */
export function pageQData(page: PageSnapshot, ctx: CheckContext): Promise<QDataResult> {
  const hit = qDataCache.get(page);
  if (hit) return hit;
  const url = qDataAddress(page.finalUrl);
  const run = async (): Promise<QDataResult> => {
    const a = await ask(ctx, url);
    if (typeof a === "string")
      return { url, read: { unread: `the q-data address could not be read: ${a}` } };
    if (a.status !== 200)
      return { url, read: { unread: `the q-data address answered ${a.status}` } };
    return { url, read: readQData(a.body, a.truncated) };
  };
  const p = run();
  qDataCache.set(page, p);
  return p;
}

export interface AcceptResult {
  json: boolean;
  vary: string[];
}

/** The page address asked again with Accept: application/json: whether it answered JSON, and its Vary. */
export async function acceptRead(
  page: PageSnapshot,
  ctx: CheckContext,
): Promise<AcceptResult | { unread: string }> {
  const a = await ask(ctx, page.finalUrl, { accept: "application/json" });
  if (typeof a === "string") return { unread: `the JSON request could not be read: ${a}` };
  if (a.status === 429 || a.status >= 500)
    return { unread: `the JSON request answered ${a.status}` };
  return {
    json: a.status >= 200 && a.status < 300 && /json/.test(type(a.headers)),
    vary: (a.headers["vary"] ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ""),
  };
}
