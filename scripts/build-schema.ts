/**
 * Generate packages/core/schema/result.v<N>.json from the zod definition.
 *   pnpm schema:build          write the file (and its hash, for a version not yet in versions.json)
 *   pnpm schema:check          compare only; exit 1 on any difference
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESULT_SCHEMA_VERSION, resultSchema } from "../packages/core/src/result.js";
import { buildSchemaText, checkSchemaDir, schemaFileName, sha256 } from "./lib/schema.js";

const dir = fileURLToPath(new URL("../packages/core/schema/", import.meta.url));
const text = buildSchemaText(resultSchema, RESULT_SCHEMA_VERSION);

if (process.argv.includes("--check")) {
  const result = checkSchemaDir(dir, RESULT_SCHEMA_VERSION, text);
  if (!result.ok) {
    for (const p of result.problems) process.stderr.write(`schema:check: ${p}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`schema:check: ${schemaFileName(RESULT_SCHEMA_VERSION)} is up to date.\n`);
  }
} else {
  const versionsFile = join(dir, "versions.json");
  const versions: Record<string, string> = existsSync(versionsFile)
    ? (JSON.parse(readFileSync(versionsFile, "utf8")) as Record<string, string>)
    : {};
  const key = String(RESULT_SCHEMA_VERSION);
  if (versions[key] !== undefined && versions[key] !== sha256(text)) {
    process.stderr.write(
      "schema:build: The result shape changed. Bump RESULT_SCHEMA_VERSION and add schema/result.v<N>.json; do not edit v1 in place.\n",
    );
    process.exitCode = 1;
  } else {
    writeFileSync(join(dir, schemaFileName(RESULT_SCHEMA_VERSION)), text);
    versions[key] = sha256(text);
    const sorted = Object.fromEntries(
      Object.entries(versions).sort(([a], [b]) => Number(a) - Number(b)),
    );
    writeFileSync(versionsFile, `${JSON.stringify(sorted, null, 2)}\n`);
    process.stdout.write(`schema:build: wrote ${schemaFileName(RESULT_SCHEMA_VERSION)}\n`);
  }
}
