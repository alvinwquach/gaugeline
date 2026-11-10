import { NetworkError } from "../errors.js";
import { isSignedLink } from "../checks/paid-files.js";
import type { Fetcher, GetOptions, Hop } from "../fetcher.js";
import { LIMITS } from "../limits.js";
import { classify, sniff, type Sniff, type Verdict } from "./classify.js";

/**
 * One anonymous GET to a download route, judged on its status, its headers and the first
 * kilobyte of the body. The body is never stored and never logged: the fetcher hands the first
 * bytes to `sniff` and keeps only the label it returns, then closes the connection.
 */

/** How a route was asked: no session, no cookie, no Authorization, no Referer, no compression, 1,024 bytes. */
export function anonymousAsk(): GetOptions {
  return {
    anonymous: true,
    maxRedirects: 0,
    // Not compressed, so what is read is the start of the file and closing the connection stops the sender.
    headers: { "accept-encoding": "identity" },
    peek: { maxBytes: LIMITS.downloadPeekBytes, sniff },
  };
}

export type RouteOutcome =
  /** The route handed the file over. `via` is set when it did so through a redirect. */
  | {
      kind: "open";
      status: number;
      contentType: string;
      via?: { status: number; host: string; signed: boolean };
    }
  /** The route refused, sent the visitor to sign in, or answered with a page. */
  | { kind: "closed"; verdict: Verdict["kind"] }
  /** No answer to judge. `reason` reads after "could not be checked:". */
  | { kind: "unclear"; reason: string };

function hopOf(hops: readonly Hop[]): Hop | undefined {
  return hops.at(-1);
}

async function ask(fetcher: Fetcher, address: string): Promise<Hop | undefined> {
  try {
    return hopOf(await fetcher.get(address, anonymousAsk()));
  } catch (err) {
    if (err instanceof NetworkError) return undefined;
    throw err;
  }
}

function verdictOf(hop: Hop, address: string): Verdict {
  return classify(hop.status, hop.headers, (hop.peek ?? "empty") as Sniff, address);
}

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return "another address";
  }
}

/**
 * Ask a route for its file as a visitor with no session and no purchase. A redirect to a sign-in
 * address is a pass without going there. A redirect to anything else is followed one hop, because
 * a route that redirects to a file (a signed storage address, say) has handed the file over.
 */
export async function askRoute(fetcher: Fetcher, address: string): Promise<RouteOutcome> {
  const first = await ask(fetcher, address);
  if (!first) return { kind: "unclear", reason: "the route did not answer" };
  const verdict = verdictOf(first, address);
  switch (verdict.kind) {
    case "open":
      return { kind: "open", status: verdict.status, contentType: verdict.contentType };
    case "page":
    case "refused":
    case "other":
      return { kind: "closed", verdict: verdict.kind };
    case "unclear":
      return {
        kind: "unclear",
        reason:
          verdict.status === 429
            ? "the route asked to be asked less often (429)"
            : `the route answered ${verdict.status}, which says nothing about whether it hands the file over`,
      };
    case "redirect": {
      if (verdict.toLogin) return { kind: "closed", verdict: "redirect" };
      if (!/^https?:\/\//i.test(verdict.location)) return { kind: "closed", verdict: "redirect" };
      const second = await ask(fetcher, verdict.location);
      if (!second)
        return {
          kind: "unclear",
          reason: "the route redirected and the address it names did not answer",
        };
      const next = verdictOf(second, verdict.location);
      if (next.kind === "open")
        return {
          kind: "open",
          status: next.status,
          contentType: next.contentType,
          via: {
            status: first.status,
            host: hostOf(verdict.location),
            signed: isSignedLink(verdict.location),
          },
        };
      if (next.kind === "redirect")
        return {
          kind: "unclear",
          reason: "the route redirected more than once; only one redirect is followed",
        };
      if (next.kind === "unclear")
        return {
          kind: "unclear",
          reason: `the address the route redirected to answered ${next.status}`,
        };
      return { kind: "closed", verdict: next.kind };
    }
  }
}
