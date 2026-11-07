import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigError, parseAddress, sitesFileSchema, type SiteEntry } from "@gaugeline/core";

export const SITES_FILE = "gaugeline.sites.json";

export interface Site extends SiteEntry {
  /** The folder its run reads gaugeline.*.json from: its config, else the sites file's folder. */
  configDir: string;
  /** host[:port], for keeping two runs of one host from overlapping. */
  host: string;
}

/** Read and check the sites file. Two sites with one name, or a config folder that's missing, stop it. */
export function readSites(dir: string, file = SITES_FILE): Site[] {
  const path = isAbsolute(file) ? file : join(dir, file);
  if (!existsSync(path))
    throw new ConfigError(`${file} not found in ${dir}.`, {
      hint: `List your sites in ${SITES_FILE}: { "sites": [{ "name": "acme", "address": "acme.example", "permission": { "by": "…", "on": "2026-11-01" } }] }`,
    });
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = sitesFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(
      `${file}: ${issue?.path.join(".") || "the file"}: ${issue?.message ?? "not a sites file"}.`,
    );
  }
  const seen = new Set<string>();
  const base = dirname(path);
  return parsed.data.sites.map((s) => {
    if (seen.has(s.name))
      throw new ConfigError(`${file}: two sites are named "${s.name}": each name must be unique.`, {
        hint: "The name is the site's run folder (runs/<name>/), so two sites can't share one.",
      });
    seen.add(s.name);
    const configDir = s.config ? resolve(base, s.config) : base;
    if (s.config && !existsSync(configDir))
      throw new ConfigError(
        `${file}: the config folder for "${s.name}" (${s.config}) does not exist.`,
      );
    const a = parseAddress(s.address);
    if (!a.ok) throw new ConfigError(`${file}: "${s.name}": ${a.reason}`);
    return { ...s, configDir, host: a.url.host };
  });
}

/** --all, --site <name> (repeatable) or --tag <tag>. A name that isn't in the file is an error. */
export function selectSites(
  sites: readonly Site[],
  pick: { all?: boolean; names?: readonly string[]; tag?: string },
): Site[] {
  if (pick.names && pick.names.length > 0) {
    const missing = pick.names.filter((n) => !sites.some((s) => s.name === n));
    if (missing.length > 0)
      throw new ConfigError(
        `No site named ${missing.map((m) => `"${m}"`).join(", ")} in ${SITES_FILE}.`,
        {
          hint: `Sites: ${sites.map((s) => s.name).join(", ")}.`,
        },
      );
    return sites.filter((s) => pick.names?.includes(s.name));
  }
  if (pick.tag !== undefined) return sites.filter((s) => s.tags?.includes(pick.tag ?? ""));
  return [...sites];
}

/** Why a site is refused before any request, or undefined. */
export function refusal(site: SiteEntry): string | undefined {
  if (!site.permission)
    return `no permission entry: add "permission": { "by": "<who agreed>", "on": "YYYY-MM-DD" } to "${site.name}" in ${SITES_FILE}`;
  return undefined;
}
