import { NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { sniffImage } from "./optimizers.js";

/** Bytes of the answer read to see whether it is an image, then the connection is closed. */
export const PROBE_PEEK_BYTES = 1024;

export type ProbeOutcome =
  /** The optimizer fetched the owner's address and sent back an image. */
  | { kind: "open"; status: number }
  /** The optimizer refused: 400, 403 or 404. */
  | { kind: "closed" }
  /** No answer to judge. `reason` reads after "could not be checked:". */
  | { kind: "unclear"; reason: string };

/**
 * One GET to one optimizer address (ADR-0007): no cookie, no redirect followed, the first
 * kilobyte read to tell an image from a page and then dropped. The answer is judged on its status,
 * its content type and those bytes. The query string is never kept or printed by the caller.
 */
export async function askOptimizer(fetcher: Fetcher, address: string): Promise<ProbeOutcome> {
  let hop;
  try {
    const hops = await fetcher.get(address, {
      anonymous: true,
      maxRedirects: 0,
      headers: { "accept-encoding": "identity", accept: "image/*" },
      peek: { maxBytes: PROBE_PEEK_BYTES, sniff: sniffImage },
    });
    hop = hops.at(-1);
  } catch (err) {
    if (err instanceof NetworkError) hop = undefined;
    else throw err;
  }
  if (!hop || hop.error) return { kind: "unclear", reason: "the optimizer did not answer" };
  const { status } = hop;
  if (status === 400 || status === 403 || status === 404) return { kind: "closed" };
  const doesNotSay = (what: string) =>
    ({
      kind: "unclear",
      reason: `the optimizer answered ${what}, which does not say whether it is open`,
    }) as const;
  if (status === 200) {
    const type = (hop.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (type.startsWith("image/") && hop.peek === "image") return { kind: "open", status };
    return doesNotSay("200 with something that is not an image");
  }
  if (status >= 300 && status < 400)
    return doesNotSay(`${status}, a redirect Gaugeline did not follow`);
  return doesNotSay(String(status));
}
