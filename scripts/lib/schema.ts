import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { SCHEMA_ID_BASE } from "../../packages/core/src/result.js";

export const BUMP_MESSAGE =
  "The result shape changed. Bump RESULT_SCHEMA_VERSION and add schema/result.v<N>.json; do not edit v1 in place.";

/**
 * Which published shape a schema file describes. The result and the `--save-requests` file are
 * versioned on their own: each has its own file stem, its own hash map and its own bump message.
 * The work order ("brief") is the Brief that buildBrief returns.
 */
export type SchemaKind = "result" | "requests" | "brief";

export const REQUESTS_BUMP_MESSAGE =
  "The saved requests file shape changed. Bump REQUESTS_FILE_SCHEMA_VERSION and add schema/requests.v<N>.json; do not edit a published file in place.";

export const BRIEF_BUMP_MESSAGE =
  "The work order (brief) shape changed. Bump BRIEF_SCHEMA_VERSION and add schema/brief.v<N>.json; do not edit a published file in place.";

const TITLES: Readonly<Record<SchemaKind, string>> = {
  result: "Gaugeline result",
  requests: "Gaugeline saved requests file",
  brief: "Gaugeline work order",
};

/** The file that maps each published version of a kind to the hash of its schema. */
export function versionsFileName(kind: SchemaKind = "result"): string {
  return kind === "result" ? "versions.json" : `${kind}-versions.json`;
}

export function bumpMessage(kind: SchemaKind = "result"): string {
  if (kind === "result") return BUMP_MESSAGE;
  return kind === "requests" ? REQUESTS_BUMP_MESSAGE : BRIEF_BUMP_MESSAGE;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Sort object keys recursively so the output never depends on declaration order. */
export function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key] as Json);
    return out;
  }
  return value;
}

/**
 * Arrays whose order carries no meaning are sorted too (`required`), so shuffling the keys of the
 * zod object cannot change the bytes.
 */
function canonicalise(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        k === "required" && Array.isArray(v) && v.every((x) => typeof x === "string")
          ? [...(v as string[])].sort()
          : canonicalise(v as Json);
    }
    return out;
  }
  return value;
}

export function schemaFileName(version: number, kind: SchemaKind = "result"): string {
  return `${kind}.v${version}.json`;
}

export function buildSchemaText(
  schema: z.ZodType,
  version: number,
  kind: SchemaKind = "result",
): string {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12" }) as { [k: string]: Json };
  const withMeta: { [k: string]: Json } = {
    ...generated,
    $id: `${SCHEMA_ID_BASE}${schemaFileName(version, kind)}`,
    title: `${TITLES[kind]} v${version}`,
  };
  return `${JSON.stringify(sortKeys(canonicalise(withMeta)), null, 2)}\n`;
}

/** Line endings are normalised first, so a CRLF checkout hashes the same as LF. */
export function normaliseText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function sha256(text: string): string {
  return createHash("sha256").update(normaliseText(text), "utf8").digest("hex");
}

export interface SchemaCheck {
  ok: boolean;
  problems: string[];
}

/** Compare a freshly generated schema with the committed file and the versions.json hash map. */
export function checkSchemaDir(
  dir: string,
  version: number,
  generated: string,
  kind: SchemaKind = "result",
): SchemaCheck {
  const problems: string[] = [];
  const file = join(dir, schemaFileName(version, kind));
  const versionsFile = join(dir, versionsFileName(kind));
  const versions: Record<string, string> = existsSync(versionsFile)
    ? (JSON.parse(readFileSync(versionsFile, "utf8")) as Record<string, string>)
    : {};
  const expectedHash = versions[String(version)];
  if (expectedHash === undefined || sha256(generated) !== expectedHash) {
    problems.push(bumpMessage(kind));
  }
  if (!existsSync(file)) {
    problems.push(`${schemaFileName(version, kind)} is missing. Run pnpm schema:build.`);
  } else if (normaliseText(readFileSync(file, "utf8")) !== normaliseText(generated)) {
    problems.push(
      `${schemaFileName(version, kind)} differs from the zod definition. Run pnpm schema:build.`,
    );
  }
  return { ok: problems.length === 0, problems };
}
