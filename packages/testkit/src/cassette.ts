import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  assertReadOnly,
  createNetworkTransport,
  findKeys,
  normaliseUrl,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "@gaugeline/core";
import { DEFAULT_SCRUBBERS, scrub, scrubUrl, type Interaction, type Scrubber } from "./scrub.js";

export interface Cassette {
  version: 1;
  name: string;
  recordedAt: string;
  interactions: Interaction[];
}

/** Same shape as the transport the fetcher accepts: pass it as createFetcher({ transport }). */
export type CassetteFetch = Transport;

export const CASSETTE_VERSION = 1;
export const CASSETTES_DIR = fileURLToPath(new URL("../cassettes/", import.meta.url));

export class CassetteMissError extends Error {
  constructor(method: string, url: string, name: string) {
    super(
      `Cassette "${name}" has no recorded answer for ${method} ${url}. Re-record with GAUGELINE_RECORD=1.`,
    );
    this.name = "CassetteMissError";
  }
}

export interface CassetteOptions {
  mode?: "replay" | "record";
  scrub?: readonly Scrubber[];
  /** Where cassettes live. Defaults to packages/testkit/cassettes. */
  dir?: string;
  /** Record mode only: the real transport to record through. Defaults to the network. */
  transport?: Transport;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

function envOn(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** Replay unless GAUGELINE_RECORD=1 (or mode "record") and not in CI. Recording in CI is refused. */
export function resolveMode(
  opts: CassetteOptions,
  env: Record<string, string | undefined>,
): "replay" | "record" {
  const wantsRecord =
    opts.mode === "record" || (opts.mode === undefined && env.GAUGELINE_RECORD === "1");
  if (!wantsRecord) return "replay";
  if (envOn(env.CI)) {
    throw new Error(
      "Refusing to record a cassette in CI. Record on your own machine with GAUGELINE_RECORD=1, review the file, commit it.",
    );
  }
  return "record";
}

export function cassettePath(name: string, dir = CASSETTES_DIR): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
    throw new Error(`Cassette name "${name}" must be kebab-case.`);
  return join(dir, `${name}.json`);
}

/** The key a request is matched on: method plus the scrubbed, normalised address. */
export function interactionKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${normaliseUrl(scrubUrl(url))}`;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k] as Json)]),
    );
  }
  return value;
}

export function serialiseCassette(c: Cassette): string {
  return `${JSON.stringify(sortKeys(c as unknown as Json), null, 2)}\n`;
}

/** Temp file then rename, so a crash mid-write never leaves a half-written cassette. */
export function writeCassetteAtomic(path: string, c: Cassette): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, serialiseCassette(c));
  renameSync(tmp, path);
}

export function readCassette(path: string): Cassette {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Cassette>;
  if (parsed.version !== CASSETTE_VERSION) {
    throw new Error(
      `Cassette ${path} is version ${String(parsed.version)}; this testkit reads version ${CASSETTE_VERSION}. Re-record it with GAUGELINE_RECORD=1.`,
    );
  }
  return parsed as Cassette;
}

function responseFrom(i: Interaction): TransportResponse {
  return {
    status: i.status,
    headers: { ...i.headers },
    body: Readable.from([Buffer.from(i.body, "utf8")]),
  };
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A key that can write: Stripe secret keys must not be used for recording; restricted (rk_) only. */
function assertReadOnlyKey(url: URL, req: TransportRequest): void {
  const values = [url.href, ...Object.values(req.headers)];
  if (values.some((v) => /\bsk_(?:live|test)_/.test(v))) {
    throw new Error(
      "Refusing to record with a Stripe secret key. Use a restricted read-only key (rk_...).",
    );
  }
}

export function useCassette(name: string, opts: CassetteOptions = {}): CassetteFetch {
  const env = opts.env ?? process.env;
  const mode = resolveMode(opts, env);
  const path = cassettePath(name, opts.dir);
  const scrubbers = opts.scrub ?? DEFAULT_SCRUBBERS;

  if (mode === "replay") {
    const cassette = readCassette(path);
    // Each useCassette call gets its own queues, so parallel tests never share state.
    const queues = new Map<string, Interaction[]>();
    for (const i of cassette.interactions) {
      const key = interactionKey(i.method, i.url);
      const q = queues.get(key) ?? [];
      q.push(i);
      queues.set(key, q);
    }
    return (url, req) => {
      assertReadOnly(req.method);
      const next = queues.get(interactionKey(req.method, url.href))?.shift();
      if (!next) return Promise.reject(new CassetteMissError(req.method, scrubUrl(url.href), name));
      return Promise.resolve(responseFrom(next));
    };
  }

  const real = opts.transport ?? createNetworkTransport();
  const cassette: Cassette = {
    version: CASSETTE_VERSION,
    name,
    recordedAt: (opts.now ?? (() => new Date()))().toISOString(),
    interactions: [],
  };
  return async (url, req) => {
    assertReadOnly(req.method);
    assertReadOnlyKey(url, req);
    const res = await real(url, req);
    const body = req.method === "HEAD" ? "" : await readAll(res.body);
    const raw: Interaction = {
      method: req.method,
      url: url.href,
      status: res.status,
      headers: res.headers,
      body,
    };
    cassette.interactions.push(scrub(raw, scrubbers));
    writeCassetteAtomic(path, cassette);
    return responseFrom({ ...raw });
  };
}

export interface CassetteProblem {
  file: string;
  path: string;
  reason: string;
}

const FORBIDDEN_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);

/** The independent second lock: anything key-shaped, any credential header, any non-read method. */
export function scanCassette(value: unknown, file: string): CassetteProblem[] {
  const problems: CassetteProblem[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      for (const name of findKeys(v))
        problems.push({ file, path, reason: `matches key pattern ${name}` });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (path.endsWith(".headers") && FORBIDDEN_HEADERS.has(k.toLowerCase())) {
          problems.push({ file, path: `${path}.${k}`, reason: `credential header ${k}` });
        }
        if (k === "method" && x !== "GET" && x !== "HEAD") {
          problems.push({
            file,
            path: `${path}.method`,
            reason: `method ${String(x)} is not GET or HEAD`,
          });
        }
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(value, "$");
  return problems;
}

export function scanCassetteDir(dir = CASSETTES_DIR): CassetteProblem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => scanCassette(JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown, f));
}
