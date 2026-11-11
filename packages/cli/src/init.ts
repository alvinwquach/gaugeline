import {
  INIT_ADAPTERS_FILE,
  createDnsReader,
  createFetcher,
  detectStack,
  planInit,
  renderInit,
  INIT_NOTES_FILE,
  type DnsReader,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";
import { inspectScaffold, writeScaffold } from "./scaffold-write.js";

export interface InitIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface InitDeps {
  fetcher?: FetcherOptions;
  dns?: DnsReader;
  /** The working folder: the only place init writes. Default: where the command ran. */
  cwd?: string;
}

/**
 * gaugeline init <site>: detect the stack from outside and write starter settings files into the working
 * folder, through the safe writer (scaffold-write.ts): all of them or none, never over an existing file
 * without --force, never outside the folder, never through a link. GET requests to the site only. Nothing
 * it writes is a key. With --dry-run it prints the files and writes nothing.
 */
export async function runInit(
  args: {
    address: string;
    typed: string;
    dryRun: boolean;
    force: boolean;
    dns: boolean;
    allowPrivate: boolean;
  },
  io: InitIo,
  deps: InitDeps,
): Promise<Outcome> {
  const cwd = deps.cwd ?? process.cwd();
  // Fail before any request when the main file is already there: there is nothing to detect for.
  if (!args.dryRun)
    await inspectScaffold([{ name: INIT_ADAPTERS_FILE }, { name: INIT_NOTES_FILE }], ".", {
      force: args.force,
      cwd,
    });
  const fetcher = createFetcher({
    ...deps.fetcher,
    // --allow-private trusts the address you typed, not where its pages point.
    ...(args.allowPrivate ? { allowPrivate: true, target: args.address } : {}),
  });
  const report = await detectStack({
    fetcher,
    address: args.address,
    ...(args.dns ? { dns: deps.dns ?? createDnsReader() } : {}),
  });
  const plan = planInit(report, args.typed);
  const wrote = args.dryRun ? [] : await writeScaffold(plan.files, ".", { force: args.force, cwd });
  io.stdout.write(renderInit({ report, plan, dryRun: args.dryRun, wrote }));
  return { kind: "ran", highFindings: 0, drift: false };
}
