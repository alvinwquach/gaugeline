import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  createFetcher,
  type Fetcher,
  type FetcherOptions,
  type Result,
  type RunResult,
  type Semaphore,
} from "@gaugeline/core";
import type { Counts, Run, Store } from "./store.js";

/** One landing page of an export. `spend` is an integer in minor units (cents, yen), never a float. */
export interface AdsDestination {
  url: string;
  ads: number;
  spend: number;
}

/** The spend of one currency. An export that mixes currencies has one of these for each. */
export interface AdsCurrency {
  /** An ISO 4217 code, or null when the export names none. */
  currency: string | null;
  destinations: AdsDestination[];
}

/** What the app API sends beside an ads run's result, in `checked.ads`. */
export interface AdsData {
  currencies: AdsCurrency[];
}

/** What reading and checking an export gives back. */
export interface AdsOutcome {
  /** The same schema 2 result `gaugeline ads <file> --json` prints: the findings are the run's problems. */
  result: Result;
  ads: AdsData;
  /** When the ads command makes a report; without one the app hides its download button. */
  report?: { result: RunResult; url: string };
}

export interface AdsContext {
  /** Makes GET and HEAD requests only, refuses private addresses, and shares the app's five-request limit. */
  fetcher: Fetcher;
  now: Date;
  /** One line of progress, in the words the terminal uses. It reaches the run's event stream. */
  onProgress(text: string): void;
}

/**
 * The ads command, as the app needs it: read the export's text, then check what it names. `read`
 * is called once, before the server starts, and throws an Error whose message is the sentence for
 * a file that cannot be used (no link column, no amount-spent column). `check` runs after.
 * The ads command in packages/core is this engine; the app has no second implementation of it.
 */
export interface AdsEngine<Parsed = unknown> {
  read(csvText: string): Parsed;
  check(parsed: Parsed, ctx: AdsContext): Promise<AdsOutcome>;
}

/** The file could not be used. `gaugeline open --ads` exits 2 with this message, before any server starts. */
export class AdsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdsInputError";
  }
}

/** An export is a spreadsheet's worth of ads; past this it is not one. */
export const ADS_FILE_LIMIT = 25 * 1024 * 1024;

/** The file, read and parsed once. Everything after this works from `parsed`, never from the path. */
export interface AdsInput<Parsed = unknown> {
  /** The file's base name: what the sidebar shows. Never the folder. */
  name: string;
  parsed: Parsed;
  engine: AdsEngine<Parsed>;
}

const WHY: Record<string, string> = {
  ENOENT: "there is no file there",
  EISDIR: "that is a folder, not a file",
  EACCES: "it is not readable by this user",
  EPERM: "it is not readable by this user",
};

/** Text from the file's bytes. Google Ads' "Excel CSV" is UTF-16 with a byte order mark; the rest is UTF-8. */
function decode(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    return swapped.swap16().toString("utf16le");
  }
  return bytes.toString("utf8");
}

/**
 * Read the export once, from the path the person typed at the terminal, and hand its text to the
 * engine. This is the only place a path is opened: no route accepts one, and no request body can
 * name a file. A missing, unreadable or unusable file is an AdsInputError.
 */
export function loadAdsFile<Parsed>(path: string, engine: AdsEngine<Parsed>): AdsInput<Parsed> {
  const name = basename(path);
  let text: string;
  try {
    const size = statSync(path).size;
    if (size > ADS_FILE_LIMIT)
      throw new AdsInputError(
        `Gaugeline cannot read ${path}: it is larger than ${ADS_FILE_LIMIT / 1024 / 1024} MB, which is more than an ads export should be.`,
      );
    text = decode(readFileSync(path));
  } catch (err) {
    if (err instanceof AdsInputError) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? "";
    throw new AdsInputError(
      `Gaugeline cannot read ${path}: ${WHY[code] ?? "it could not be opened"}.`,
    );
  }
  let parsed: Parsed;
  try {
    parsed = engine.read(text);
  } catch (err) {
    // The engine's own sentence, as it prints it for `gaugeline ads`.
    throw new AdsInputError(err instanceof Error ? err.message : String(err));
  }
  return { name, parsed, engine };
}

export interface AdsRunDeps {
  /** The app's fetcher options (tests pass a fixture's hosts map or a transport). */
  fetcher?: FetcherOptions;
  /** The in-flight limit every run in the session shares. */
  semaphore: Semaphore;
  now?: () => Date;
}

/** A number the table can show exactly: a count, or an amount in minor units. */
const whole = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** What the client would drop is refused here, with a sentence, so the run fails instead of showing nothing. */
function assertAdsData(data: AdsData): void {
  for (const c of data.currencies)
    for (const d of c.destinations)
      if (!whole(d.ads) || !whole(d.spend))
        throw new Error("The ads check returned spend that is not a whole number of cents.");
}

/**
 * Add a run of kind "ads" under the file's base name and check what the export names. Its progress
 * goes to the same event stream as a page check's; its requests go through a fetcher of the app's
 * own, so the five-request limit and the refusal of private addresses hold.
 */
export function startAdsRun(
  input: AdsInput,
  store: Store,
  deps: AdsRunDeps,
): { run: Run; finished: Promise<void> } {
  const now = deps.now?.() ?? new Date();
  const run = store.add(input.name, now, "ads");
  const finished = (async () => {
    try {
      const fetcher = createFetcher({ ...deps.fetcher, semaphore: deps.semaphore });
      const outcome = await input.engine.check(input.parsed, {
        fetcher,
        now,
        onProgress: (text) => store.emit(run, { event: "step", data: { text } }),
      });
      assertAdsData(outcome.ads);
      const counts: Counts = { high: 0, medium: 0, low: 0 };
      for (const f of outcome.result.findings) counts[f.severity]++;
      run.result = outcome.result;
      run.ads = outcome.ads;
      if (outcome.report) run.report = outcome.report;
      run.counts = counts;
      run.state = "done";
      store.emit(run, { event: "done", data: { counts } });
    } catch (err) {
      run.state = "failed";
      run.reason = err instanceof Error ? err.message : String(err);
      store.emit(run, { event: "failed", data: { reason: run.reason } });
    }
  })();
  return { run, finished };
}
