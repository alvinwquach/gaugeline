import {
  LEVELS,
  type AdsData,
  type AdsDestination,
  REQUEST_KINDS,
  type Checked,
  type Counts,
  type DatasetView,
  type LeaksView,
  type ScriptView,
  type RequestRow,
  type StructuredBlock,
  type Result,
  type RunDetail,
  type RunSummary,
  type WatchEvent,
} from "./types";

/** The result version this app reads. Another version is refused with a sentence, never guessed at. */
export const RESULT_SCHEMA = 2;

/** A refusal with a sentence the page can show as it is. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** One request to the app's own server. Same origin: the browser sends the session cookie. */
async function call(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(
      0,
      "The app couldn't reach Gaugeline on this computer. Is gaugeline open still running?",
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (res.ok) throw new ApiError(res.status, "Gaugeline's answer wasn't JSON.");
    throw new ApiError(res.status, `Gaugeline answered ${res.status} with no message.`);
  }
  if (!res.ok) {
    const sentence = isObject(body) && typeof body.error === "string" ? body.error : undefined;
    throw new ApiError(res.status, sentence ?? `Gaugeline answered ${res.status} with no message.`);
  }
  return body;
}

/** What the app is running as: the demo (example results, no checks) or a normal session. */
export interface AppSession {
  demo: boolean;
  version: string;
}

/** GET /api/session. Anything that isn't the shape is an error, and the app then behaves as a normal session. */
export async function readSession(): Promise<AppSession> {
  const body = await call("/api/session");
  if (!isObject(body) || typeof body.demo !== "boolean" || typeof body.version !== "string")
    throw new ApiError(200, "Gaugeline didn't say what kind of session this is.");
  return { demo: body.demo, version: body.version };
}

/** Where a finished run's report is downloaded from: the same file `gaugeline <address>` writes. */
export const reportPath = (runId: string) => `/api/runs/${encodeURIComponent(runId)}/report`;

/** POST /api/check. A 400 (or 413, 415, 429) comes back as an ApiError carrying the server's sentence. */
export async function startCheck(url: string): Promise<{ id: string }> {
  const body = await call("/api/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!isObject(body) || typeof body.id !== "string")
    throw new ApiError(202, "Gaugeline didn't say which run it started.");
  return { id: body.id };
}

function readCounts(v: unknown): Counts | undefined {
  if (!isObject(v)) return undefined;
  const { high, medium, low } = v;
  if (typeof high !== "number" || typeof medium !== "number" || typeof low !== "number")
    return undefined;
  return { high, medium, low };
}

function readSummary(v: unknown): RunSummary {
  if (
    !isObject(v) ||
    typeof v.id !== "string" ||
    typeof v.url !== "string" ||
    typeof v.startedAt !== "string" ||
    (v.state !== "running" && v.state !== "done" && v.state !== "failed")
  )
    throw new ApiError(200, "Gaugeline sent a run the app can't read.");
  const counts = readCounts(v.counts);
  return {
    id: v.id,
    url: v.url,
    ...(v.kind === "ads" ? { kind: "ads" as const } : {}),
    state: v.state,
    startedAt: v.startedAt,
    ...(counts ? { counts } : {}),
  };
}

/**
 * The versioned JSON from `gaugeline --json`, checked just enough to be drawn: the version, the
 * lists and the fields the views read. Anything else in it is ignored.
 */
export function readResult(v: unknown): Result {
  if (!isObject(v)) throw new Error("The result isn't an object.");
  if (v.schema !== RESULT_SCHEMA)
    throw new Error(
      `This app reads result schema ${RESULT_SCHEMA}; this result is schema ${String(v.schema)}.`,
    );
  if (typeof v.url !== "string" || typeof v.startedAt !== "string")
    throw new Error("The result has no address or start time.");
  if (!Array.isArray(v.findings)) throw new Error("The result has no findings list.");
  const findings = v.findings.map((f: unknown) => {
    if (
      !isObject(f) ||
      typeof f.checkId !== "string" ||
      typeof f.title !== "string" ||
      typeof f.evidence !== "string" ||
      typeof f.url !== "string" ||
      !LEVELS.some((l) => l === f.severity)
    )
      throw new Error("The result has a finding the app can't read.");
    return {
      checkId: f.checkId,
      severity: f.severity as Result["findings"][number]["severity"],
      title: f.title,
      evidence: f.evidence,
      url: f.url,
    };
  });
  if (!isStrings(v.passed)) throw new Error("The result has no list of passed checks.");
  if (!isStrings(v.failed)) throw new Error("The result has no list of failed checks.");
  if (!Array.isArray(v.couldNotCheck)) throw new Error("The result has no could-not-check list.");
  const couldNotCheck = v.couldNotCheck.map((c: unknown) => {
    if (
      !isObject(c) ||
      typeof c.id !== "string" ||
      typeof c.reason !== "string" ||
      typeof c.url !== "string"
    )
      throw new Error("The result has a could-not-check entry the app can't read.");
    return { id: c.id, reason: c.reason, url: c.url };
  });
  if (!isObject(v.sampled)) throw new Error("The result has no sampled counts.");
  const sampled: Result["sampled"] = {};
  for (const [kind, s] of Object.entries(v.sampled)) {
    if (
      !isObject(s) ||
      typeof s.seen !== "number" ||
      typeof s.taken !== "number" ||
      typeof s.limit !== "number"
    )
      throw new Error("The result has sampled counts the app can't read.");
    sampled[kind] = { seen: s.seen, taken: s.taken, limit: s.limit };
  }
  return {
    schema: RESULT_SCHEMA,
    url: v.url,
    startedAt: v.startedAt,
    findings,
    passed: v.passed,
    failed: v.failed,
    couldNotCheck,
    sampled,
  };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function readRequest(v: unknown): RequestRow | undefined {
  if (
    !isObject(v) ||
    !isString(v.url) ||
    !REQUEST_KINDS.some((k) => k === v.kind) ||
    (v.method !== "GET" && v.method !== "HEAD") ||
    !(v.status === null || isCount(v.status)) ||
    !isCount(v.ms) ||
    (v.location !== undefined && !isString(v.location)) ||
    (v.error !== undefined &&
      v.error !== "timeout" &&
      v.error !== "private-address-refused" &&
      v.error !== "no-answer")
  )
    return undefined;
  return {
    url: v.url,
    kind: v.kind as RequestRow["kind"],
    method: v.method,
    status: v.status,
    ...(v.error ? { error: v.error } : {}),
    ms: v.ms,
    ...(v.location !== undefined ? { location: v.location } : {}),
  };
}

function readBlock(v: unknown): StructuredBlock | undefined {
  if (!isObject(v)) return undefined;
  if (v.ok === true && "value" in v) return { ok: true, value: v.value };
  if (v.ok === false && isString(v.raw) && isString(v.error))
    return { ok: false, raw: v.raw, error: v.error };
  return undefined;
}

function readStrings(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(isString) ? v : undefined;
}

function readDataset(v: unknown): DatasetView | undefined {
  if (
    !isObject(v) ||
    !isString(v.projectId) ||
    !isString(v.dataset) ||
    (v.state !== "public" && v.state !== "private" && v.state !== "unknown") ||
    (v.count !== undefined && !isCount(v.count))
  )
    return undefined;
  const types = v.types === undefined ? [] : readStrings(v.types);
  if (!types) return undefined;
  // Only these fields are copied, so a field the server should not have sent never goes further.
  return {
    projectId: v.projectId,
    dataset: v.dataset,
    state: v.state,
    ...(v.count !== undefined ? { count: v.count as number } : {}),
    ...(v.types !== undefined ? { types } : {}),
  };
}

function readScript(v: unknown): ScriptView | undefined {
  if (
    !isObject(v) ||
    !isString(v.url) ||
    !isString(v.where) ||
    !(v.status === null || isCount(v.status)) ||
    typeof v.truncated !== "boolean"
  )
    return undefined;
  return { url: v.url, where: v.where, status: v.status as number | null, truncated: v.truncated };
}

/** The lists the Leaks & access view is made from; anything that isn't the shape is dropped as a whole. */
function readLeaks(v: unknown): LeaksView | undefined {
  if (!isObject(v)) return undefined;
  const previews = readStrings(v.previews);
  if (!previews) return undefined;
  let datasets: DatasetView[] | undefined;
  if (v.datasets !== undefined) {
    if (!Array.isArray(v.datasets)) return undefined;
    const read = v.datasets.map(readDataset);
    if (read.some((d) => d === undefined)) return undefined;
    datasets = read as DatasetView[];
  }
  let scripts: ScriptView[] | undefined;
  if (v.scripts !== undefined) {
    if (!Array.isArray(v.scripts)) return undefined;
    const read = v.scripts.map(readScript);
    if (read.some((s) => s === undefined)) return undefined;
    scripts = read as ScriptView[];
  }
  return { ...(datasets ? { datasets } : {}), ...(scripts ? { scripts } : {}), previews };
}

/**
 * What the server sends beside the result for the Pages checked and Search data views, checked just
 * enough to be drawn. Anything that isn't the shape is dropped as a whole: those views then say the
 * run has no list, and the rest of the app is unaffected.
 */
export function readChecked(v: unknown): Checked | undefined {
  if (!isObject(v) || !isObject(v.page)) return undefined;
  const p = v.page;
  if (
    !isString(p.url) ||
    (p.title !== undefined && !isString(p.title)) ||
    (p.canonical !== undefined && !isString(p.canonical)) ||
    !isCount(p.words) ||
    !isString(p.firstWords) ||
    !Array.isArray(p.blocks)
  )
    return undefined;
  const blocks = p.blocks.map(readBlock);
  if (blocks.some((b) => b === undefined)) return undefined;
  let requests: RequestRow[] | undefined;
  if (v.requests !== undefined) {
    if (!Array.isArray(v.requests)) return undefined;
    const rows = v.requests.map(readRequest);
    if (rows.some((r) => r === undefined)) return undefined;
    requests = rows as RequestRow[];
  }
  const leaks = v.leaks === undefined ? undefined : readLeaks(v.leaks);
  return {
    ...(requests ? { requests } : {}),
    ...(leaks ? { leaks } : {}),
    page: {
      url: p.url,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.canonical !== undefined ? { canonical: p.canonical } : {}),
      words: p.words,
      firstWords: p.firstWords,
      blocks: blocks as StructuredBlock[],
    },
  };
}

function readDestination(v: unknown): AdsDestination | undefined {
  if (!isObject(v) || !isString(v.url) || !isCount(v.ads) || !Number.isInteger(v.ads))
    return undefined;
  // Spend is a whole number of minor units, never a float: anything else is not drawn.
  if (typeof v.spend !== "number" || !Number.isSafeInteger(v.spend) || v.spend < 0)
    return undefined;
  return { url: v.url, ads: v.ads, spend: v.spend };
}

/**
 * The destinations and their spend, from an ads run's `checked` field. Anything that isn't the
 * shape is dropped as a whole, and the Ads view then says it has no list.
 */
export function readAds(v: unknown): AdsData | undefined {
  if (!isObject(v) || !isObject(v.ads) || !Array.isArray(v.ads.currencies)) return undefined;
  const currencies: AdsData["currencies"] = [];
  for (const c of v.ads.currencies) {
    if (
      !isObject(c) ||
      !(c.currency === null || isString(c.currency)) ||
      !Array.isArray(c.destinations)
    )
      return undefined;
    const read = c.destinations.map(readDestination);
    if (read.some((d) => d === undefined)) return undefined;
    currencies.push({ currency: c.currency, destinations: read as AdsDestination[] });
  }
  return { currencies };
}

/** GET /api/runs: every run in this session, oldest first. */
export async function listRuns(): Promise<RunSummary[]> {
  const body = await call("/api/runs");
  if (!Array.isArray(body)) throw new ApiError(200, "Gaugeline's list of runs wasn't a list.");
  return body.map(readSummary);
}

/** GET /api/runs/:id: the run, with its result once it is done or its reason once it failed. */
export async function getRun(id: string): Promise<RunDetail> {
  const body = await call(`/api/runs/${encodeURIComponent(id)}`);
  const summary = readSummary(body);
  const raw = body as Record<string, unknown>;
  return {
    ...summary,
    ...(raw.result !== undefined ? { result: readResult(raw.result) } : {}),
    ...(readChecked(raw.checked) ? { checked: readChecked(raw.checked) as Checked } : {}),
    ...(readAds(raw.checked) ? { ads: readAds(raw.checked) as AdsData } : {}),
    ...(raw.hasReport === true ? { hasReport: true } : {}),
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
  };
}

function data(e: Event): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse((e as MessageEvent<string>).data);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Follow one run's event stream. Steps, then done or failed (the stream is closed after either).
 * When the connection drops, the run is read again: if it ended, that is reported as a "sync"; if
 * it is still going, the stream is opened again. The server replays every event from the start,
 * which the store drops by event id.
 */
export function watchRun(
  id: string,
  onEvent: (e: WatchEvent) => void,
  opts: { retryMs?: number } = {},
): () => void {
  const retryMs = opts.retryMs ?? 1000;
  let stopped = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  const open = () => {
    if (stopped) return;
    const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
    source = es;
    const eventId = (e: Event) => Number((e as MessageEvent).lastEventId) || 0;
    const live = () => !stopped && source === es;
    es.addEventListener("step", (e) => {
      const d = data(e);
      if (live() && typeof d?.text === "string")
        onEvent({ kind: "step", id: eventId(e), text: d.text });
    });
    es.addEventListener("done", (e) => {
      const counts = readCounts(data(e)?.counts);
      if (!live()) return;
      es.close();
      if (counts) onEvent({ kind: "done", id: eventId(e), counts });
      else recover();
    });
    es.addEventListener("failed", (e) => {
      const d = data(e);
      if (!live()) return;
      es.close();
      onEvent({
        kind: "failed",
        id: eventId(e),
        reason: typeof d?.reason === "string" ? d.reason : "The check could not run.",
      });
    });
    es.onerror = () => {
      if (!live()) return;
      // The browser would reconnect by itself; this closes it so the run is read first.
      es.close();
      recover();
    };
  };

  const recover = () => {
    getRun(id).then(
      (run) => {
        if (stopped) return;
        attempts = 0;
        onEvent({ kind: "sync", run });
        if (run.state === "running") timer = setTimeout(open, retryMs);
      },
      (err: unknown) => {
        // A run the server no longer has, or an app that can't be reached for good: stop asking.
        if (stopped || (err instanceof ApiError && err.status !== 0)) return;
        attempts += 1;
        if (attempts < 5) timer = setTimeout(recover, retryMs);
      },
    );
  };

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
}
