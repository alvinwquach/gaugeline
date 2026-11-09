import { AsyncLocalStorage } from "node:async_hooks";
import { redact } from "./redact.js";

/**
 * What a run asked for, kept for the app's "Pages checked" view: every request the fetcher sent
 * (or refused to send), with the kind of address it was. No headers, no bodies.
 */

/** What an address was requested as. The order is the order the app lists them in. */
export const REQUEST_KINDS = [
  "page",
  "link",
  "image",
  "sitemap",
  "feed",
  "script",
  "extra-page",
  "other",
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** Why a request has no status: no answer in time, a non-public address that was not requested, or any other failure. */
export type RequestError = "timeout" | "private-address-refused" | "no-answer";

/** One request, as the fetcher keeps it. `chain` and `hop` give the order it was asked for. */
export interface RequestRecord {
  url: string;
  kind: RequestKind;
  method: "GET" | "HEAD";
  /** null when nothing answered. */
  status: number | null;
  error?: RequestError;
  ms: number;
  /** Where a 3xx pointed, as an absolute address. */
  location?: string;
  /** Which get() call this belongs to, in call order, and which hop of its redirects. */
  chain: number;
  hop: number;
}

/** A request as the result carries it: the order is the order of the list. */
export type RequestRow = Omit<RequestRecord, "chain" | "hop">;

const kinds = new AsyncLocalStorage<RequestKind>();

/** Run `fn` so that every address it asks the fetcher for is recorded as `kind`. The nearest one wins. */
export function inKind<T>(kind: RequestKind, fn: () => T): T {
  return kinds.run(kind, fn);
}

/** The kind the code now running was asked to record, or "other". */
export function currentKind(): RequestKind {
  return kinds.getStore() ?? "other";
}

/** Wrap a lazy sampler so what it requests is recorded as `kind`. Own properties (peek) are kept. */
export function kinded<F extends () => unknown>(kind: RequestKind, fn: F): F {
  const wrapped = (() => inKind(kind, fn)) as F;
  return Object.assign(wrapped, fn);
}

const RANK: Readonly<Record<RequestKind, number>> = Object.fromEntries(
  REQUEST_KINDS.map((k, i) => [k, i]),
) as Record<RequestKind, number>;

/**
 * The records as the result carries them: by kind, then by the order they were requested (the
 * order is the order of the sample, not of the answers, so the same site lists the same way).
 * Secret-looking text in an address is removed.
 */
export function requestRows(records: readonly RequestRecord[]): RequestRow[] {
  return [...records]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.chain - b.chain || a.hop - b.hop)
    .map(({ chain: _c, hop: _h, url, location, ...rest }) => ({
      ...rest,
      url: redact(url),
      ...(location === undefined ? {} : { location: redact(location) }),
    }));
}
