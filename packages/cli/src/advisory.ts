import {
  checkAdvisory,
  createDnsReader,
  createFetcher,
  renderAdvisoryNote,
  renderAdvisoryTerminal,
  type DnsReader,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";

export interface AdvisoryIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface AdvisoryDeps {
  fetcher?: FetcherOptions;
  dns?: DnsReader;
  now?: () => Date;
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
  const result = await checkAdvisory({
    fetcher,
    address: args.address,
    spec: args.spec,
    packages: args.packages,
    hosts: args.hosts,
    ...(args.dns ? { dns: deps.dns ?? createDnsReader() } : {}),
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
