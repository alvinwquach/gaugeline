import {
  ConfigError,
  SANITY_DATASET,
  SANITY_PROJECT_ID,
  SANITY_TOKEN,
  createFetcher,
  freezeEnv,
  suggestForType,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env?: Record<string, string | undefined>;
}

interface Deps {
  cwd: string;
  fetcher?: FetcherOptions;
}

/** The two lines that end the output, as comments so the whole text is still a valid query. */
export const SUGGEST_WARNING = [
  "// This describes what your content has today, not what your page needs.",
  "// Delete what the page does not use: every field you ask for is data you pay to fetch and render.",
];

/**
 * gaugeline query <folder> --suggest --type <name>: write a GROQ query from the newest published
 * documents of a type. One GET (more only if the documents are too long for one answer), drafts
 * left out. Only field names, kinds and counts are kept: no value is printed, logged or stored.
 * The query goes to stdout and no file is written. The folder is checked to exist, as for the other
 * query modes, and is not read. Needs SANITY_PROJECT_ID. A type with no published documents is
 * exit 2 and prints no query.
 */
export async function runSuggest(
  args: { dir: string; suggest: { type: string }; allowPrivate?: boolean; quiet?: boolean },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  const folder = resolve(deps.cwd, args.dir);
  const info = await stat(folder).catch(() => null);
  if (info === null || !info.isDirectory())
    throw new ConfigError(
      info ? `${args.dir} is a file, not a folder.` : `The folder ${args.dir} does not exist.`,
      {
        hint: "Give the folder of your site's source: gaugeline query ./src --suggest --type resource",
      },
    );
  if ((io.env?.[SANITY_PROJECT_ID] ?? "").trim() === "")
    throw new ConfigError(
      "gaugeline query --suggest reads the published documents of a type from your dataset, and that needs SANITY_PROJECT_ID.",
      {
        hint: "Set SANITY_PROJECT_ID (and SANITY_TOKEN, with the Viewer role, for a private dataset).",
      },
    );
  const run = await suggestForType({
    type: args.suggest.type,
    env: freezeEnv(io.env ?? {}, [SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN]),
    fetcher: createFetcher({
      ...deps.fetcher,
      ...(args.allowPrivate === true ? { allowPrivate: true } : {}),
    }),
  });
  if (args.quiet !== true) for (const n of run.notices) io.stderr.write(`${n}\n`);
  if (run.query === undefined)
    throw new ConfigError(
      `Nothing of type ${run.shape.type} exists in the published documents of the dataset "${run.dataset}".`,
      {
        hint: "Check the type name against your Studio schema (it is case-sensitive), and that the documents are published, not only drafts.",
      },
    );
  if (args.quiet !== true)
    io.stderr.write(
      `Read the newest ${run.shape.sampled} published ${run.shape.sampled === 1 ? "document" : "documents"} of ${run.shape.type} and kept only their field names, kinds and counts.\n`,
    );
  io.stdout.write(`${run.query}\n${SUGGEST_WARNING.join("\n")}\n`);
  return { kind: "ran", highFindings: 0, drift: false };
}
