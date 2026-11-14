import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  ConfigError,
  createFetcher,
  createMigrationRegistry,
  readExportFile,
  readMigration,
  readOldSite,
  unreadPages,
  runChecks,
  type FetcherOptions,
  type OldList,
  type Outcome,
} from "@gaugeline/core";
import { formatTerminal } from "./reporter.js";

export interface MigrationIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  color: boolean;
}

export interface MigrationDeps {
  cwd?: string;
  fetcher?: FetcherOptions;
}

const SOURCE_NAME = {
  wordpress: "the WordPress API",
  sitemap: "the sitemap",
  links: "the home page's links",
  file: "the export",
} as const;

/** gaugeline migration <new-address> (--old <address> | --old-file <export>) */
export async function runMigration(
  args: {
    address: string;
    old?: string;
    oldFile?: string;
    allowPrivate: boolean;
    quiet: boolean;
  },
  io: MigrationIo,
  deps: MigrationDeps,
): Promise<Outcome> {
  const cwd = deps.cwd ?? process.cwd();
  // The export is read before anything is asked of any site: a missing file is exit 2 with no request.
  let fromFile: OldList | undefined;
  if (args.oldFile !== undefined) {
    const path = resolve(cwd, args.oldFile);
    if (!existsSync(path))
      throw new ConfigError(`${args.oldFile} does not exist.`, {
        hint: "Export the old site's pages from Wix or Webflow as CSV or JSON, then give its path.",
      });
    fromFile = readExportFile(readFileSync(path, "utf8"));
  }
  const newOrigin = new URL(args.address);
  const fetcher = createFetcher({
    ...deps.fetcher,
    ...(args.allowPrivate ? { allowPrivate: true } : {}),
  });
  const list = fromFile ?? (await readOldSite(fetcher, args.old ?? ""));
  const reading = await readMigration({
    fetcher,
    newAddress: newOrigin.href,
    ...(args.old !== undefined ? { oldAddress: args.old } : {}),
    list,
  });
  const result = await runChecks(reading, createMigrationRegistry());
  const from =
    args.oldFile !== undefined
      ? basename(args.oldFile)
      : `${new URL(args.old ?? newOrigin.href).host} (${SOURCE_NAME[list.source]})`;
  io.stdout.write(
    `Checking ${list.items.length} ${list.items.length === 1 ? "page" : "pages"} from ${from} on ${newOrigin.host}\n`,
  );
  io.stdout.write(formatTerminal({ result, color: io.color, origin: reading.newOrigin }));
  if (!args.quiet) for (const note of list.notes) io.stderr.write(`${note}\n`);
  const unreadable = unreadPages(reading);
  return {
    kind: "ran",
    highFindings: result.findings.filter((f) => f.severity === "high").length,
    drift: false,
    // A page the new site would not give leaves its checks undecided: exit 2, not a quiet 0.
    incomplete: unreadable > 0,
  };
}
