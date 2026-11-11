/**
 * Generate the published JSON Schema files in packages/core/schema/ from their zod definitions:
 * result.v<N>.json (the --json result), requests.v<N>.json (the --save-requests file) and
 * brief.v<N>.json (the work order the brief formatter returns). Each has
 * its own version number and its own hash map, so the two shapes change independently.
 *   pnpm schema:build          write the files (and their hashes, for a version not yet in the map)
 *   pnpm schema:check          compare only; exit 1 on any difference
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as z from "zod";
import { BRIEF_SCHEMA_VERSION, briefSchema } from "../packages/core/src/report/brief-schema.js";
import {
  REQUESTS_FILE_SCHEMA_VERSION,
  requestsFileSchema,
} from "../packages/core/src/requests-file.js";
import { RESULT_SCHEMA_VERSION, resultSchema } from "../packages/core/src/result.js";
import {
  bumpMessage,
  buildSchemaText,
  checkSchemaDir,
  schemaFileName,
  sha256,
  versionsFileName,
  type SchemaKind,
} from "./lib/schema.js";

const dir = fileURLToPath(new URL("../packages/core/schema/", import.meta.url));

const SHAPES: ReadonlyArray<{ kind: SchemaKind; schema: z.ZodType; version: number }> = [
  { kind: "result", schema: resultSchema, version: RESULT_SCHEMA_VERSION },
  { kind: "requests", schema: requestsFileSchema, version: REQUESTS_FILE_SCHEMA_VERSION },
  { kind: "brief", schema: briefSchema, version: BRIEF_SCHEMA_VERSION },
];

const check = process.argv.includes("--check");
for (const { kind, schema, version } of SHAPES) {
  const text = buildSchemaText(schema, version, kind);
  const name = schemaFileName(version, kind);
  if (check) {
    const result = checkSchemaDir(dir, version, text, kind);
    if (!result.ok) {
      for (const p of result.problems) process.stderr.write(`schema:check: ${p}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`schema:check: ${name} is up to date.\n`);
    }
    continue;
  }
  const versionsFile = join(dir, versionsFileName(kind));
  const versions: Record<string, string> = existsSync(versionsFile)
    ? (JSON.parse(readFileSync(versionsFile, "utf8")) as Record<string, string>)
    : {};
  const key = String(version);
  if (versions[key] !== undefined && versions[key] !== sha256(text)) {
    process.stderr.write(`schema:build: ${bumpMessage(kind)}\n`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(join(dir, name), text);
  versions[key] = sha256(text);
  const sorted = Object.fromEntries(
    Object.entries(versions).sort(([a], [b]) => Number(a) - Number(b)),
  );
  writeFileSync(versionsFile, `${JSON.stringify(sorted, null, 2)}\n`);
  process.stdout.write(`schema:build: wrote ${name}\n`);
}
