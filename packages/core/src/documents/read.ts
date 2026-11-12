import type { Fetcher, Hop } from "../fetcher.js";
import { LIMITS } from "../limits.js";
import type { DocumentReader, DocumentText } from "./types.js";

export type DocumentOutcome =
  /** Not a document after all (an HTML page): nothing is said. */
  | { kind: "page" }
  /** Not read, with the reason: too big, refused, unreachable, cut short, not a PDF. */
  | { kind: "not-read"; url: string; reason: string }
  | { kind: "read"; url: string; lastModified?: string; text: DocumentText };

const MB = 1024 * 1024;
export const megabytes = (bytes: number): string => `${Math.round((bytes / MB) * 10) / 10} MB`;

const header = (hop: Hop, name: string): string | undefined => hop.headers[name];

/**
 * One document: a HEAD for its size, type and date, then a GET of the bytes only when it is small
 * enough (the size cap is the limit plus one byte, so a server that sends no length is caught too),
 * then the reader. Redirects are followed by the fetcher, so a menu on a file host is read where it
 * ends up, and that final address is the one reported. Read only: GET and HEAD, nothing sent.
 */
export async function readDocument(
  url: string,
  deps: { fetcher: Fetcher; reader: DocumentReader; maxBytes?: number },
): Promise<DocumentOutcome> {
  const max = deps.maxBytes ?? LIMITS.documentBytes;
  const size = (n: number): string => `${megabytes(n)}, over the ${megabytes(max)} limit`;
  let at = url;
  let lastModified: string | undefined;
  try {
    const head = (await deps.fetcher.get(url, { method: "HEAD" })).at(-1);
    if (head) {
      at = head.url;
      if (head.status >= 200 && head.status < 300) {
        const type = header(head, "content-type") ?? "";
        if (/text\/html|application\/xhtml/i.test(type)) return { kind: "page" };
        const length = Number(header(head, "content-length"));
        if (Number.isFinite(length) && length > max)
          return { kind: "not-read", url: at, reason: `skipped: the file is ${size(length)}` };
        lastModified = header(head, "last-modified");
      } else if (head.status !== 405 && head.status !== 501) {
        return { kind: "not-read", url: at, reason: `the server answered ${head.status}` };
      }
    }
  } catch {
    // A server that refuses HEAD is asked with GET below.
  }
  let hops: Hop[];
  try {
    hops = await deps.fetcher.get(at, { binary: true, maxBytes: max + 1 });
  } catch (err) {
    return {
      kind: "not-read",
      url: at,
      reason: `could not be fetched (${err instanceof Error ? err.message : "no answer"})`,
    };
  }
  const last = hops.at(-1);
  if (!last) return { kind: "not-read", url: at, reason: "could not be fetched" };
  if (last.status < 200 || last.status >= 300)
    return { kind: "not-read", url: last.url, reason: `the server answered ${last.status}` };
  if (/text\/html/i.test(header(last, "content-type") ?? "")) return { kind: "page" };
  if ((last.bytes ?? 0) > max)
    return {
      kind: "not-read",
      url: last.url,
      reason: `skipped: the file is over the ${megabytes(max)} limit`,
    };
  lastModified ??= header(last, "last-modified");
  const text = deps.reader.read(Buffer.from(last.body ?? "", "latin1"));
  return { kind: "read", url: last.url, ...(lastModified ? { lastModified } : {}), text };
}
