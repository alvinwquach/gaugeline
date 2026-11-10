import { ConfigError } from "@gaugeline/core";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The schema file for --mutations and --suggest: the one --schema names, else ./schema.json where the command
 * ran, else schema.json in the folder that is read. Nothing else is looked for and nothing is fetched.
 */
export async function schemaPath(
  cwd: string,
  dir: string,
  given: string | undefined,
  flag = "--mutations",
): Promise<string> {
  if (given !== undefined) return resolve(cwd, given);
  const candidates = [resolve(cwd, "schema.json"), resolve(cwd, dir, "schema.json")];
  for (const c of candidates) if ((await stat(c).catch(() => null))?.isFile()) return c;
  throw new ConfigError(
    `gaugeline query ${flag} needs the schema, and there is no schema.json in the current folder or in the folder it reads.`,
    {
      hint: "Write it with `npx sanity schema extract`, then pass it with --schema ./schema.json. Gaugeline makes no request to fetch it.",
    },
  );
}
