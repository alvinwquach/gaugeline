import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConfigError,
  buildFindingsBaseline,
  parseConfig,
  parseFindingsBaseline,
  type Config,
  type Finding,
  type FindingsBaseline,
} from "@gaugeline/core";

/**
 * The config file, read from the folder gaugeline runs in and nowhere else: never from a fetched
 * site, never from a parent folder. JSON is data and the safe default. .mjs, .js and .ts are
 * programs: loading one runs the code in it, as loading an ESLint or Vite config does, so use them
 * only in a folder you trust. One file only: two are an error, so no file is ignored in silence.
 */
export const CONFIG_FILES = [
  "gaugeline.config.json",
  "gaugeline.config.mjs",
  "gaugeline.config.js",
  "gaugeline.config.ts",
] as const;

export interface LoadedConfig {
  /** The file's name, for messages. */
  file: string;
  /** True for a file that ran code (.mjs, .js, .ts). */
  executable: boolean;
  config: Config;
}

/** Does this Node strip TypeScript types when it imports a .ts file? (Node 22.18 and newer, and 24.) */
function canStripTypes(): boolean {
  const f = (process.features as unknown as { typescript?: unknown }).typescript;
  return f === "strip" || f === "transform" || f === true;
}

export async function loadConfig(
  cwd: string,
  opts: { importer?: (url: string) => Promise<unknown>; jsonOnly?: boolean } = {},
): Promise<LoadedConfig | undefined> {
  const found = CONFIG_FILES.filter((f) => existsSync(join(cwd, f)));
  if (found.length === 0) return undefined;
  if (found.length > 1)
    throw new ConfigError(`More than one config file here: ${found.join(", ")}.`, {
      hint: "Keep one, so no file is ignored without you knowing.",
    });
  const file = found[0] as (typeof CONFIG_FILES)[number];
  const path = resolve(cwd, file);
  if (file.endsWith(".json")) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`, {
        hint: "Fix the file, or remove it.",
      });
    }
    return { file, executable: false, config: parseConfig(json, file) };
  }
  if (opts.jsonOnly)
    throw new ConfigError(
      `${file} is a program, and this run accepts a JSON config only (--config-json-only or GAUGELINE_NO_EXEC_CONFIG).`,
      {
        hint: "Move what it sets into gaugeline.config.json, or run without the option in a folder you trust.",
      },
    );
  if (file.endsWith(".ts") && !canStripTypes())
    throw new ConfigError(
      `${file} needs a Node that can run TypeScript files (22.18 or newer; this is ${process.versions.node}).`,
      { hint: "Use gaugeline.config.json or gaugeline.config.mjs, or update Node." },
    );
  let mod: unknown;
  try {
    mod = await (opts.importer ?? ((u: string) => import(u)))(pathToFileURL(path).href);
  } catch (err) {
    throw new ConfigError(`${file} could not be loaded: ${(err as Error).message}`, {
      hint: 'A config that imports from "gaugeline" needs gaugeline installed in this project: npm install --save-dev gaugeline.',
    });
  }
  const exported = (mod as { default?: unknown }).default;
  if (exported === undefined)
    throw new ConfigError(`${file} has no default export.`, {
      hint: "Write: export default { checks: {}, custom: [], suppress: [] }.",
    });
  return { file, executable: true, config: parseConfig(exported, file) };
}

/** Read a baseline file; undefined when it does not exist. A file that is there and wrong is an error. */
export function readBaselineFile(cwd: string, name: string): FindingsBaseline | undefined {
  const path = resolve(cwd, name);
  if (!existsSync(path)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${name} is not valid JSON: ${(err as Error).message}`, {
      hint: `Write a fresh baseline with --baseline ${name} --update-baseline.`,
    });
  }
  return parseFindingsBaseline(json, name);
}

/** Write a baseline (to a temp file, then rename): fingerprints, check ids and paths, never evidence. */
export function writeBaselineFile(
  cwd: string,
  name: string,
  findings: readonly Finding[],
  now: Date,
): number {
  const baseline = buildFindingsBaseline(findings, now);
  const path = resolve(cwd, name);
  try {
    writeFileSync(`${path}.tmp`, `${JSON.stringify(baseline, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  } catch (err) {
    throw new ConfigError(
      `${name} cannot be written (${(err as { code?: string }).code ?? "an error"}).`,
      { hint: "Give --baseline a path in a folder you can write to." },
    );
  }
  return baseline.findings.length;
}
