import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ConfigError,
  accessConfigSchema,
  factsConfigSchema,
  hiddenConfigSchema,
  languageRulesSchema,
  paymentsConfigSchema,
  readContainer,
  schemaRulesSchema,
  tagsConfigSchema,
  type AccessConfig,
  type FactsConfig,
  type HiddenConfig,
  type LanguageRules,
  type PaymentsConfig,
  type SchemaRules,
  type TagContainer,
} from "@gaugeline/core";
import type * as z from "zod";

/** The schema guide's file name, read from the working directory until the config file (G29) lands. */
export const SCHEMA_CONFIG_FILE = "gaugeline.schema.json";
/** The language settings' file name, likewise. */
export const LANGUAGES_CONFIG_FILE = "gaugeline.languages.json";
/** The business's declared facts, likewise. */
export const FACTS_CONFIG_FILE = "gaugeline.facts.json";
/** The business's payment handles and links, likewise. */
export const PAYMENTS_CONFIG_FILE = "gaugeline.payments.json";
/** The database project and roles to test its access rules as, likewise. Keys stay in the environment. */
export const ACCESS_CONFIG_FILE = "gaugeline.access.json";
/** Sections hidden until launch, likewise. */
export const HIDDEN_CONFIG_FILE = "gaugeline.hidden.json";
/** Where the Tag Manager container export is, likewise. The export is a file: no account is used. */
export const TAGS_CONFIG_FILE = "gaugeline.tags.json";

/** A JSON settings file in `dir`, validated, or undefined when there is none. Invalid is a ConfigError. */
function readJsonConfig<T>(
  dir: string,
  file: string,
  schema: z.ZodType<T>,
  what: string,
): T | undefined {
  const path = join(dir, file);
  if (!existsSync(path)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`, {
      hint: `Fix the file, or remove it to run without ${what}.`,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "the file";
    throw new ConfigError(`${file}: ${where}: ${issue?.message ?? "not valid"}.`, {
      hint: `See the docs for the shape of ${file}.`,
    });
  }
  return parsed.data;
}

export function readSchemaRules(dir: string): SchemaRules | undefined {
  return readJsonConfig(dir, SCHEMA_CONFIG_FILE, schemaRulesSchema, "a schema guide");
}

export function readLanguageRules(dir: string): LanguageRules | undefined {
  return readJsonConfig(dir, LANGUAGES_CONFIG_FILE, languageRulesSchema, "language settings");
}

export function readFacts(dir: string): FactsConfig | undefined {
  return readJsonConfig(dir, FACTS_CONFIG_FILE, factsConfigSchema, "declared facts");
}

export function readPayments(dir: string): PaymentsConfig | undefined {
  return readJsonConfig(dir, PAYMENTS_CONFIG_FILE, paymentsConfigSchema, "payment details");
}

export function readAccess(dir: string): AccessConfig | undefined {
  return readJsonConfig(dir, ACCESS_CONFIG_FILE, accessConfigSchema, "database access checks");
}

export function readHidden(dir: string): HiddenConfig | undefined {
  return readJsonConfig(dir, HIDDEN_CONFIG_FILE, hiddenConfigSchema, "hidden sections");
}

/** The container export gaugeline.tags.json names (relative to that file), read and parsed. */
export function readTags(dir: string): TagContainer | undefined {
  const config = readJsonConfig(dir, TAGS_CONFIG_FILE, tagsConfigSchema, "the tag rule checks");
  if (!config) return undefined;
  const path = resolve(dirname(join(dir, TAGS_CONFIG_FILE)), config.container);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new ConfigError(
      code === "ENOENT"
        ? `${TAGS_CONFIG_FILE}: container: ${config.container} was not found.`
        : `${config.container} is not valid JSON: ${(err as Error).message}`,
      {
        hint: "Export the container from Tag Manager (Admin > Export container) and name that file.",
      },
    );
  }
  return readContainer(json, config.container);
}
