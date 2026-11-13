/**
 * A local stand-in for the two Sanity requests the writer makes, for tests and for the guide's runnable
 * example (docs/guides/cms-fix-drafts.md). It holds documents in memory and answers in the shapes recorded in
 * the Sanity client's source and README (see the pull request's Sources): a read returns
 * `{ documents: [...] }`; a `create` of a new id answers `{ transactionId, results: [{ id, operation }] }`;
 * a `create` of an id that exists answers 409. It checks every request against the registry first, so a
 * request the registry would refuse never reaches it. It opens no connection and needs no account or token.
 */
import { checkSanityRequest, type SanityRequest, type SanityTarget } from "./endpoints.js";
import type { SanityResponse } from "./send.js";

type Doc = Record<string, unknown>;

export interface StandInOptions {
  /** The documents that exist to begin with (live ones, and any `drafts.` ones). */
  documents?: readonly Doc[];
  /** Called after each request is answered, with the number of requests so far. */
  after?: (count: number) => void;
  /** Answer every write with this status and an error body. */
  writeStatus?: number;
  /** Answer every read with this status and an error body. */
  readStatus?: number;
}

export function createSanityStandIn(target: SanityTarget, options: StandInOptions = {}) {
  const sent: SanityRequest[] = [];
  const docs = new Map<string, Doc>();
  for (const d of options.documents ?? []) docs.set(String(d._id), structuredClone(d));
  const send = async (req: SanityRequest): Promise<SanityResponse> => {
    checkSanityRequest(req, target);
    sent.push(structuredClone(req));
    try {
      if (req.endpoint === "getDoc") {
        if (options.readStatus)
          return { status: options.readStatus, json: { error: "RESPONSE-TEXT" } };
        const doc = docs.get(req.path.split("/").pop()!);
        return { status: 200, json: { documents: doc ? [structuredClone(doc)] : [] } };
      }
      if (options.writeStatus)
        return { status: options.writeStatus, json: { error: { description: "RESPONSE-TEXT" } } };
      const created = (req.body!.mutations as { create: Doc }[])[0]!.create;
      const id = String(created._id);
      if (docs.has(id)) return { status: 409, json: { error: { description: "RESPONSE-TEXT" } } };
      docs.set(id, structuredClone(created));
      return {
        status: 200,
        json: { transactionId: "tx1", results: [{ id, operation: "create" }] },
      };
    } finally {
      options.after?.(sent.length);
    }
  };
  return { sent, send, docs, writes: () => sent.filter((r) => r.endpoint === "mutate") };
}
