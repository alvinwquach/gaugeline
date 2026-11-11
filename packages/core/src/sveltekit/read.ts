import { NetworkError } from "../errors.js";
import { FetchError } from "../fetcher.js";
import type { CheckContext } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { appPrefix, dataAddress, readDataJson, type DataRead } from "./detect.js";

const type = (h: { headers: Record<string, string> } | undefined): string =>
  (h?.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

/** A refusal to answer, or an error, is never a finding: the reason a read could not be made. */
const unreadStatus = (s: number): boolean => s === 401 || s === 403 || s === 429 || s >= 400;

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

export interface DataResult {
  url: string;
  read: DataRead;
}
const dataCache = new WeakMap<PageSnapshot, Promise<DataResult>>();

/** The page's own `__data.json`, asked for once and shared by the checks that read it. */
export function pageData(page: PageSnapshot, ctx: CheckContext): Promise<DataResult> {
  const hit = dataCache.get(page);
  if (hit) return hit;
  const url = dataAddress(page.finalUrl);
  const run = async (): Promise<DataResult> => {
    const a = await ask(ctx, url);
    if (typeof a === "string")
      return { url, read: { unread: `the data address could not be read: ${a}` } };
    if (unreadStatus(a.status))
      return { url, read: { unread: `the data address answered ${a.status}` } };
    return { url, read: readDataJson(a.body, type({ headers: a.headers }), a.truncated) };
  };
  const p = run();
  dataCache.set(page, p);
  return p;
}

/** The build's version name from `<appDir>/version.json`, or why it could not be read. */
export async function liveVersion(
  page: PageSnapshot,
  ctx: CheckContext,
): Promise<{ url: string; version: string } | { url?: string; unread: string }> {
  const prefix = appPrefix(page);
  if (prefix === undefined)
    return { unread: "the page names no module of its own to find the app folder from" };
  if (new URL(prefix).origin !== new URL(page.finalUrl).origin)
    return {
      unread:
        "the page's modules are served from another host, so its version file is not asked for",
    };
  const url = `${prefix}/version.json`;
  const a = await ask(ctx, url);
  if (typeof a === "string") return { url, unread: `${url} could not be read: ${a}` };
  if (a.status !== 200 || a.truncated || a.body.length > 2_000)
    return { url, unread: `${url} answered ${a.status}, or is not a small file` };
  try {
    const v = (JSON.parse(a.body) as { version?: unknown } | null)?.version;
    if (typeof v === "string" && v.length > 0 && v.length <= 200) return { url, version: v };
  } catch {
    // falls through
  }
  return { url, unread: `${url} is not {"version": "..."}` };
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
    json: a.status >= 200 && a.status < 300 && /json/.test(type({ headers: a.headers })),
    vary: (a.headers.vary ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ""),
  };
}
