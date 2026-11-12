import type { CheckContext } from "../model.js";
import { getOrNull } from "../probe.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  configFields,
  findDataScript,
  parseFlat,
  payloadFields,
  type StateField,
} from "./state.js";

/** What a Nuxt page's embedded state holds, read once per page and shared by the checks that need it. */
export interface NuxtRead {
  /** The flat payloads read: the inline __NUXT_DATA__ script, and the page's own _payload.json when it points at one. */
  flats: unknown[][];
  /** Every field name found, with where it was found. Never a value. */
  fields: (StateField & { where: "payload" | "config" })[];
  /** Why a part of the state could not be read; each becomes a could-not-check line. */
  unread: string[];
}

const cache = new WeakMap<PageSnapshot, Promise<NuxtRead>>();

/** The address a data script points at, when it is this site's own _payload.json (a path, not a query). */
export function ownPayloadUrl(src: string, pageUrl: string): string | undefined {
  try {
    const u = new URL(src, pageUrl);
    const page = new URL(pageUrl);
    if (u.origin !== page.origin || !/\/_payload\.json$/.test(u.pathname)) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

async function read(page: PageSnapshot, ctx: CheckContext): Promise<NuxtRead> {
  const last = page.hops.at(-1);
  const body = last?.body ?? "";
  const out: NuxtRead = { flats: [], fields: [], unread: [] };
  for (const f of configFields(body)) out.fields.push({ ...f, where: "config" });
  const script = findDataScript(body, last?.truncated === true);
  if (script.kind === "unread") out.unread.push(script.reason);
  if (script.kind === "none" && last?.truncated === true && out.fields.length === 0)
    out.unread.push("the page was cut at the size limit before any state was found");
  const add = (text: string, where: string): void => {
    const parsed = parseFlat(text);
    if ("reason" in parsed) {
      out.unread.push(`${where}: ${parsed.reason}`);
      return;
    }
    out.flats.push(parsed.flat);
  };
  if (script.kind === "inline" && script.text.trim() !== "") add(script.text, "__NUXT_DATA__");
  if (script.kind === "external") {
    const url = ownPayloadUrl(script.src, page.finalUrl);
    if (!url) out.unread.push("the payload file is not on this site, so it was not asked for");
    else if (!ctx.fetcher || !ctx.budget) out.unread.push("the payload file was not asked for");
    else if (ctx.budget.take("nuxtAddresses", [url]).length === 0)
      out.unread.push("the payload file was left out by the limit on Nuxt addresses");
    else {
      const hop = (await getOrNull(ctx.fetcher, url)).at(-1);
      if (!hop) out.unread.push("the payload file did not answer");
      else if (hop.status !== 200) out.unread.push(`the payload file answered ${hop.status}`);
      else if (hop.truncated === true)
        out.unread.push("the payload file was cut at the size limit");
      else add(hop.body ?? "", "_payload.json");
    }
  }
  for (const flat of out.flats)
    for (const f of payloadFields(flat)) out.fields.push({ ...f, where: "payload" });
  return out;
}

export function readNuxtState(page: PageSnapshot, ctx: CheckContext): Promise<NuxtRead> {
  const hit = cache.get(page);
  if (hit) return hit;
  const run = read(page, ctx);
  cache.set(page, run);
  return run;
}
