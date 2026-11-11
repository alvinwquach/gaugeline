import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  WORDPRESS_ENV_VARS,
  checkAdvisory,
  createDnsReader,
  createFetcher,
  BUILT_ADAPTERS,
  createAdapter,
  freezeEnv,
  renderAdvisoryNote,
  renderAdvisoryTerminal,
  type DnsReader,
  type Fetcher,
  type FetcherOptions,
  type Outcome,
  type WordPressAdapter,
  type WordPressData,
} from "@gaugeline/core";
import { readAdaptersConfig } from "./schema-config.js";

export interface AdvisoryIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  /** The environment: WORDPRESS_URL, WORDPRESS_USER and WORDPRESS_APP_PASSWORD, when gaugeline.adapters.json names wordpress. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface AdvisoryDeps {
  fetcher?: FetcherOptions;
  dns?: DnsReader;
  now?: () => Date;
  /** Where gaugeline.adapters.json is looked for. Default: the working folder. */
  cwd?: string;
}

/**
 * What the WordPress adapter reads of the site's installed plugins and themes, when gaugeline.adapters.json names
 * `wordpress`: the advisory's answer then uses their versions in place of what the page's file addresses show.
 * WordPress lists them only to an administrator, so a key that may not is a note on stderr and the run goes on
 * with what the page shows. Nothing is read when the file does not name wordpress.
 */
function wordpressRead(
  cwd: string,
  io: AdvisoryIo,
  fetcher: Fetcher,
  quiet: boolean,
  address: string,
): (() => Promise<WordPressData | undefined>) | undefined {
  const entry = readAdaptersConfig(cwd)?.adapters.find((a) => a.id === "wordpress");
  if (!entry) return undefined;
  // Called only once the advisory is known to be about WordPress (checkAdvisory decides), so an Administrator's key
  // is not used for any other advisory.
  return () => readInstalled(entry, io, fetcher, quiet, address);
}

const bare = (h: string): string => h.toLowerCase().replace(/^www\./, "");

async function readInstalled(
  entry: NonNullable<ReturnType<typeof readAdaptersConfig>>["adapters"][number],
  io: AdvisoryIo,
  fetcher: Fetcher,
  quiet: boolean,
  address: string,
): Promise<WordPressData | undefined> {
  const env = freezeEnv(io.env ?? {}, WORDPRESS_ENV_VARS);
  // The adapter's list is about the site WORDPRESS_URL names. It is used for that site only, and is not even asked
  // for when the site being checked is another one.
  let named = "";
  try {
    named = new URL((env.WORDPRESS_URL ?? "").trim()).hostname;
  } catch {
    named = "";
  }
  const checked = new URL(address).hostname;
  if (named !== "" && bare(named) !== bare(checked)) {
    if (!quiet)
      io.stderr.write(
        `The WordPress adapter in gaugeline.adapters.json names ${named}, not ${checked}, so its list of installed plugins was not used. The answer uses what the page shows.\n`,
      );
    return undefined;
  }
  try {
    // Loaded here, the first time this run needs it (the registry's loader), and not at start-up.
    const built = BUILT_ADAPTERS.get("wordpress");
    if (!built) return undefined;
    const adapter = (await createAdapter(built, { env, fetcher }, entry)) as WordPressAdapter;
    return await adapter.installed();
  } catch (err) {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) {
      if (!quiet)
        io.stderr.write(
          `The WordPress adapter's list of installed plugins was not read: ${err instanceof AdapterCouldNotCheck ? err.reason : err.message} The answer uses what the page shows.\n`,
        );
      return undefined;
    }
    throw err;
  }
}

/**
 * gaugeline advisory <site> <id | package@range>: the answer, from outside only. One GET of api.osv.dev for an
 * id (none for a package and range), then GET requests to the site's own pages. --json prints the data
 * (schema/advisory.v1.json), --note the Markdown note for the client, and neither the report.
 */
export async function runAdvisory(
  args: {
    address: string;
    spec: string;
    packages: string[];
    hosts: string[];
    dns: boolean;
    note: boolean;
    json: boolean;
    allowPrivate: boolean;
    quiet: boolean;
  },
  io: AdvisoryIo,
  deps: AdvisoryDeps,
): Promise<Outcome> {
  const fetcher = createFetcher({
    ...deps.fetcher,
    // --allow-private trusts the address you typed, not where its pages point.
    ...(args.allowPrivate ? { allowPrivate: true, target: args.address } : {}),
  });
  const wordpress = wordpressRead(deps.cwd ?? process.cwd(), io, fetcher, args.quiet, args.address);
  const result = await checkAdvisory({
    fetcher,
    address: args.address,
    spec: args.spec,
    packages: args.packages,
    hosts: args.hosts,
    ...(args.dns ? { dns: deps.dns ?? createDnsReader() } : {}),
    ...(wordpress ? { wordpress } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  io.stdout.write(
    args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : args.note
        ? renderAdvisoryNote(result)
        : renderAdvisoryTerminal(result),
  );
  return {
    kind: "ran",
    highFindings: result.verdict === "likely-affected" ? 1 : 0,
    drift: false,
  };
}
