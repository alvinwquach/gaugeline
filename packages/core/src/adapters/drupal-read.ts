import type { Fetcher, Hop } from "../fetcher.js";
import { type PartialRead } from "./collect.js";
import type { DrupalAdapter, UnpublishedRead } from "./drupal.js";
import { DRUPAL_LIMITS } from "./drupal.entry.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";

/**
 * How Drupal answered a visitor who asked for an unpublished node's own page:
 * - `closed`: Drupal itself said no (HTTP 403, or 404), which is what an unpublished node answers a visitor.
 * - `open`: Drupal itself served a page at that address (HTTP 2xx).
 * - `unread`: no answer that says either; `reason` says why. A firewall's 403, a login page, a redirect elsewhere and a
 *   page that does not say Drupal sent it are all this, never a pass.
 */
export type NodeAnswer =
  | { kind: "closed"; status: number }
  | { kind: "open"; status: number }
  | { kind: "unread"; reason: string };

/** What a second look, with the credential, found for a node that answered a visitor: still unpublished, published meanwhile, or not read. */
export type Recheck = "unpublished" | "published" | { unread: string };

export interface NodeRead {
  type: string;
  /** The JSON:API id. */
  id: string;
  /** The node number. */
  nid: string;
  /** The address asked for, in full. */
  url: string;
  /** Its path, for the words a finding uses. */
  path: string;
  answer: NodeAnswer;
  /** Only for an `open` answer. */
  recheck?: Recheck;
}

/**
 * What the Drupal check needs, read once: for each type the settings name, which nodes the credential can list that are
 * not published, and how Drupal answered a visitor who asked for each node's own page. Ids, node numbers, addresses and
 * statuses only: never a title, a field or a body.
 */
export interface DrupalReading {
  /** The origin of the Drupal site that was asked, or "" when DRUPAL_URL was not usable (see `setup`). */
  site: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Without it nothing is asked. */
  ownerConsent: boolean;
  /** The settings say (`readUnpublished`) that unpublished nodes may be listed. Without it nothing is asked. */
  unpublishedAllowed: boolean;
  /** The environment holds a credential. Without one nothing is asked. */
  hasCredential: boolean;
  /** The settings name no type, so nothing was read: the check is could-not-check, not a pass. */
  nothingNamed: boolean;
  /** Why the read could not start (DRUPAL_URL or the credential is not usable), when it could not. */
  setup?: string;
  types: UnpublishedRead[];
  pages: NodeRead[];
  /** Nodes with a page that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadDrupalOptions {
  adapter: DrupalAdapter;
  /** The same fetcher the adapter uses, or another: it asks the Drupal site's own pages here, with no credential. */
  fetcher: Fetcher;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
  /** Replaces DRUPAL_LIMITS.pages. For tests. */
  maxPages?: number;
}

/** Drupal sends `X-Generator: Drupal 10 (https://www.drupal.org)` with its own answers; its pages also carry a generator meta tag. */
function fromDrupal(hop: Hop): boolean {
  if (/^drupal\b/i.test(hop.headers["x-generator"] ?? "")) return true;
  return /<meta\s+name=["']Generator["']\s+content=["']Drupal\b/i.test(hop.body ?? "");
}

const trim = (path: string): string => path.replace(/\/+$/, "") || "/";

/**
 * One node's own page, as a visitor: a GET with no credential, no cookie and nothing the fetcher adds per address. A
 * redirect is followed up to three times, only within the same host, and the answer counts only when it is Drupal's own
 * (a 403 from a firewall is not "closed") and the final path is the node's path or its alias.
 */
async function askNode(
  fetcher: Fetcher,
  url: string,
  alias: string | undefined,
): Promise<NodeAnswer> {
  const asked = new URL(url);
  // Redirects are followed here, one at a time, and only to the same host: the Location a site sends is never asked for
  // when it points elsewhere (the answer of another site says nothing about this node).
  let at = url;
  let last: Hop | undefined;
  for (let hop = 0; hop <= 3; hop++) {
    try {
      last = (await fetcher.get(at, { anonymous: true, maxRedirects: 0 })).at(-1);
    } catch (err) {
      return { kind: "unread", reason: err instanceof Error ? err.message : String(err) };
    }
    if (!last) return { kind: "unread", reason: "no answer" };
    if (last.status < 300 || last.status >= 400) break;
    const location = last.headers.location;
    let next: URL | undefined;
    try {
      next = location === undefined ? undefined : new URL(location, at);
    } catch {
      next = undefined;
    }
    if (!next)
      return {
        kind: "unread",
        reason: `the site answered ${last.status}, a redirect with no usable address`,
      };
    if (
      (next.protocol !== "https:" && next.protocol !== "http:") ||
      next.host.toLowerCase() !== asked.host.toLowerCase()
    )
      return { kind: "unread", reason: "the address redirects to another site" };
    at = next.href;
  }
  if (!last) return { kind: "unread", reason: "no answer" };
  if (last.status >= 300 && last.status < 400)
    return { kind: "unread", reason: "the address redirects more than three times" };
  const finalPath = trim(new URL(at).pathname);
  const ok =
    finalPath === trim(asked.pathname) || (alias !== undefined && finalPath === trim(alias));
  const open = last.status >= 200 && last.status < 300;
  const closed = last.status === 403 || last.status === 404;
  if (!open && !closed) return { kind: "unread", reason: `the site answered ${last.status}` };
  if (!ok) return { kind: "unread", reason: `the address redirects to ${new URL(at).pathname}` };
  if (!fromDrupal(last))
    return {
      kind: "unread",
      reason: `the site answered ${last.status}, but nothing in the answer says Drupal sent it (a firewall, a proxy or a front end may be answering)`,
    };
  return open ? { kind: "open", status: last.status } : { kind: "closed", status: last.status };
}

/**
 * Read a Drupal site for the unpublished-node check. Only with the owner's consent (CLAUDE.md rule 14), only when the
 * settings say `readUnpublished: true`, only with a credential, and only for the types the settings name: per type, the
 * unpublished nodes as ids and node numbers, and for each one GET of its own page, with no credential. A page that
 * answers a visitor is looked at once more with the credential (is the node still unpublished?), so a node that was
 * published while the check ran is never reported. A type Drupal will not give is recorded with its reason and the
 * others are still read; a rate limit that stays ends the read and marks it partial.
 */
export async function readDrupal(options: ReadDrupalOptions): Promise<DrupalReading> {
  const { adapter, fetcher } = options;
  const budget = options.maxPages ?? DRUPAL_LIMITS.pages;
  const reading: DrupalReading = {
    site: "",
    ownerConsent: options.ownerConsent === true,
    unpublishedAllowed: adapter.unpublishedAllowed(),
    hasCredential: adapter.hasCredential(),
    nothingNamed: adapter.collections().length === 0,
    types: [],
    pages: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };
  // Nothing is asked without the owner's consent, without the settings entry, without a credential, or with nothing to ask about.
  if (
    !reading.ownerConsent ||
    !reading.unpublishedAllowed ||
    !reading.hasCredential ||
    reading.nothingNamed
  )
    return reading;
  try {
    reading.site = adapter.origin();
    reading.types = await adapter.unpublishedReading();
  } catch (err) {
    if (err instanceof AdapterRateLimitedError) {
      const had = Array.isArray(err.partial) ? (err.partial as UnpublishedRead[]) : [];
      reading.types = had;
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: had.length,
      };
    } else if (err instanceof AdapterCouldNotCheck) {
      reading.setup = err.reason;
      return reading;
    } else throw err;
  }

  const todo: Omit<NodeRead, "answer">[] = [];
  const aliases = new Map<string, string | undefined>();
  for (const t of reading.types) {
    if (t.state !== "read") continue;
    for (const n of t.nodes) {
      const url = adapter.nodeAddress(n.nid);
      aliases.set(url, n.alias);
      todo.push({ type: t.type, id: n.id, nid: n.nid, url, path: new URL(url).pathname });
    }
  }
  const asked = todo.slice(0, budget);
  reading.pagesSkipped = todo.length - asked.length;
  reading.pages = await Promise.all(
    asked.map(async (p): Promise<NodeRead> => ({
      ...p,
      answer: await askNode(fetcher, p.url, aliases.get(p.url)),
    })),
  );
  // A page that opened for a visitor is looked at again with the credential: one that was published in between is not a finding.
  for (const p of reading.pages) {
    if (p.answer.kind !== "open") continue;
    try {
      p.recheck = (await adapter.stillUnpublished(p.type, p.id)) ? "unpublished" : "published";
    } catch (err) {
      if (err instanceof AdapterRateLimitedError)
        p.recheck = { unread: "Drupal asked Gaugeline to slow down" };
      else if (err instanceof AdapterCouldNotCheck) p.recheck = { unread: err.reason };
      else throw err;
    }
  }
  return reading;
}
