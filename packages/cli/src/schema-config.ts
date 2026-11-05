import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, schemaRulesSchema, type SchemaRules } from "@gaugeline/core";

/** The schema guide's file name, read from the working directory until the config file (G29) lands. */
export const SCHEMA_CONFIG_FILE = "gaugeline.schema.json";

/** The schema guide in `dir`, or undefined when there is none. A file that is not valid is a ConfigError. */
export function readSchemaRules(dir: string): SchemaRules | undefined {
  const path = join(dir, SCHEMA_CONFIG_FILE);
  if (!existsSync(path)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${SCHEMA_CONFIG_FILE} is not valid JSON: ${(err as Error).message}`, {
      hint: "Fix the file, or remove it to run without a schema guide.",
    });
  }
  const parsed = schemaRulesSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "the file";
    throw new ConfigError(
      `${SCHEMA_CONFIG_FILE}: ${where}: ${issue?.message ?? "not a schema guide"}.`,
      {
        hint: "See the schema rules guide for the shape: organizationId, websiteId, templates, breadcrumbs.",
      },
    );
  }
  return parsed.data;
}
