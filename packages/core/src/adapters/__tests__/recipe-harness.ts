import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import type {
  AdapterSettings,
  ContentAdapter,
  PublishedDoc,
  PublishedOptions,
  TypeCount,
} from "../types.js";

/**
 * The recorded-response test format for a recipe (docs/integrations/recipes). It is stable on purpose: a native adapter for
 * the same platform (C-08 to C-11, C-17 to C-31) must read the same recorded answers and give the same `expect`, and the
 * recipe stays as the fallback. Version 1:
 *
 * - `<id>.json`: `{ format: 1, recipe, name, settings }`, where `settings` is an entry of gaugeline.adapters.json.
 * - `<id>.recorded.json`: `{ format: 1, recipe, provenance, env, exchanges, expect }`.
 *   - `env`: the environment variables the mapping names, with invented values.
 *   - `exchanges[]`: `{ request: { url, query, headers? }, response: { status, headers?, body } }`. A request matches when it
 *     is a GET to `url` (origin and path), every parameter in `query` has that value (others are ignored) and every header
 *     in `headers` has that value (`{env:NAME}` stands for the variable). The most specific match answers. Anything else is
 *     a 404 and is reported in `misses`.
 *   - `expect`: `options` (what published() is asked, with the fields to hash), `countType` and `countFields` (for
 *     fieldCounts), `drafts` (whether draftsReachable() is asked), and the answers: `types`, `fieldCounts`, `published` (docs),
 *     `draftsReachable`.
 */
export interface Exchange {
  request: { url: string; query: Record<string, string>; headers?: Record<string, string> };
  response: { status: number; headers?: Record<string, string>; body: unknown };
}

export interface Expect {
  options: PublishedOptions;
  countType: string;
  countFields: string[];
  drafts: boolean;
  types?: TypeCount[];
  fieldCounts?: Record<string, number>;
  published?: PublishedDoc[];
  draftsReachable?: boolean | "not-applicable";
}

export interface Recording {
  format: 1;
  recipe: string;
  provenance: string;
  env: Record<string, string>;
  exchanges: Exchange[];
  expect: Expect;
}

export interface RecipeFile {
  format: 1;
  recipe: string;
  name: string;
  settings: AdapterSettings;
}

export const RECIPES_DIR = fileURLToPath(
  new URL("../../../../../docs/integrations/recipes/", import.meta.url),
);

export function loadRecipeFiles(): { recipe: RecipeFile; recording: Recording }[] {
  return readdirSync(RECIPES_DIR)
    .filter((f) => f.endsWith(".recorded.json"))
    .sort()
    .map((f) => ({
      recipe: JSON.parse(
        readFileSync(`${RECIPES_DIR}${f.replace(".recorded", "")}`, "utf8"),
      ) as RecipeFile,
      recording: JSON.parse(readFileSync(`${RECIPES_DIR}${f}`, "utf8")) as Recording,
    }));
}

export interface Replay {
  fetcher: Fetcher;
  sleep: (ms: number) => Promise<void>;
  /** Every request, in order, with its headers. */
  seen: { method: string; url: string; headers: Record<string, string> }[];
  /** Requests no exchange answered. */
  misses: string[];
  /** Indexes of the exchanges nothing asked for. */
  unused: () => number[];
}

export function replayTransport(recording: Recording): {
  transport: Transport;
  seen: Replay["seen"];
  misses: string[];
  unused: () => number[];
} {
  const used = new Set<number>();
  const seen: Replay["seen"] = [];
  const misses: string[] = [];
  const fill = (v: string): string =>
    v.replace(/\{env:([A-Z0-9_]+)\}/g, (_m, n: string) => recording.env[n] ?? "");
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    Promise.resolve({
      status,
      headers: { "content-type": "application/json", ...headers },
      body: Readable.from([Buffer.from(JSON.stringify(body))]),
    });
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    let best = -1;
    let bestScore = -1;
    recording.exchanges.forEach((e, i) => {
      const at = new URL(e.request.url);
      if (req.method !== "GET" || at.origin !== url.origin || at.pathname !== url.pathname) return;
      const q = Object.entries(e.request.query);
      if (!q.every(([k, v]) => url.searchParams.get(k) === v)) return;
      const h = Object.entries(e.request.headers ?? {});
      if (!h.every(([k, v]) => req.headers[k.toLowerCase()] === fill(v))) return;
      if (q.length + h.length > bestScore) {
        best = i;
        bestScore = q.length + h.length;
      }
    });
    const hit = recording.exchanges[best];
    if (!hit) {
      misses.push(`${req.method} ${url.href}`);
      return answer(404, { error: "no recorded answer" });
    }
    used.add(best);
    return answer(hit.response.status, hit.response.body, hit.response.headers);
  };
  return {
    transport,
    seen,
    misses,
    unused: () => recording.exchanges.map((_e, i) => i).filter((i) => !used.has(i)),
  };
}

/** Run an adapter over a recording and return the answers in the shape of `expect`. */
export async function replay(
  recording: Recording,
  make: (world: {
    env: Record<string, string>;
    fetcher: Fetcher;
    sleep: (ms: number) => Promise<void>;
  }) => ContentAdapter,
): Promise<{ answers: Expect; seen: Replay["seen"]; misses: string[]; unused: () => number[] }> {
  const { transport, seen, misses, unused } = replayTransport(recording);
  const fetcher = createFetcher({ transport, timeoutMs: 5000 });
  const adapter = make({ env: recording.env, fetcher, sleep: () => Promise.resolve() });
  const { options, countType, countFields, drafts } = recording.expect;
  const answers: Expect = {
    options,
    countType,
    countFields,
    drafts,
    types: await adapter.types(),
    fieldCounts: await adapter.fieldCounts(countType, countFields),
    published: (await collectPublished(adapter, options)).docs,
    ...(drafts ? { draftsReachable: await adapter.draftsReachable() } : {}),
  };
  return { answers, seen, misses, unused };
}
