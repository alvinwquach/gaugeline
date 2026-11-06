import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, type Finding } from "@gaugeline/core";

/** Findings dismissed with a reason, read from the working directory until the config file (G29). */
export const IGNORE_FILE = "gaugeline.ignore.json";

export interface IgnoreEntry {
  checkId: string;
  url?: string;
  reason: string;
  at?: string;
}

export type IgnoreList = IgnoreEntry[];

/** Validated by hand: the CLI bundles core only, so it carries no schema library of its own. */
function parseIgnore(json: unknown): IgnoreList {
  const fail = (where: string, what: string): never => {
    throw new ConfigError(`${IGNORE_FILE}: ${where}: ${what}.`, {
      hint: `Each entry is { "checkId": "...", "url": "...", "reason": "..." }.`,
    });
  };
  if (
    json === null ||
    typeof json !== "object" ||
    !Array.isArray((json as { ignore?: unknown }).ignore)
  )
    fail("the file", 'must be { "ignore": [ ... ] }');
  return (json as { ignore: unknown[] }).ignore.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    if (typeof o.checkId !== "string" || o.checkId === "")
      fail(`ignore.${i}.checkId`, "must be a check id");
    if (typeof o.reason !== "string" || o.reason.trim() === "")
      fail(`ignore.${i}.reason`, "must say why");
    if (o.url !== undefined && typeof o.url !== "string")
      fail(`ignore.${i}.url`, "must be an address");
    return {
      checkId: o.checkId as string,
      reason: o.reason as string,
      ...(typeof o.url === "string" ? { url: o.url } : {}),
      ...(typeof o.at === "string" ? { at: o.at } : {}),
    };
  });
}

export function readIgnore(dir: string): IgnoreList {
  const path = join(dir, IGNORE_FILE);
  if (!existsSync(path)) return [];
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${IGNORE_FILE} is not valid JSON: ${(err as Error).message}`, {
      hint: `Fix the file, or remove it to stop dismissing findings.`,
    });
  }
  return parseIgnore(json);
}

/** Add a dismissal (write to a temp file, then rename). */
export function addIgnore(
  dir: string,
  entry: { checkId: string; url: string; reason: string },
  now: Date,
): void {
  const list = readIgnore(dir);
  list.push({ ...entry, at: now.toISOString() });
  const path = join(dir, IGNORE_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ ignore: list }, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** Leave out findings on the ignore list (same check, and the same address when one is given). */
export function applyIgnore(
  findings: readonly Finding[],
  list: IgnoreList,
): { kept: Finding[]; dismissed: number } {
  const kept = findings.filter(
    (f) => !list.some((i) => i.checkId === f.checkId && (i.url === undefined || i.url === f.url)),
  );
  return { kept, dismissed: findings.length - kept.length };
}
