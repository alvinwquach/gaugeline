import * as z from "zod";
import { ConfigError } from "../errors.js";
import { defineCheck, type Check, type CheckRegistry } from "../model.js";

/**
 * gaugeline.config.(json|mjs|js|ts): which checks block, the checks you wrote, and findings snoozed
 * with a reason and a date. Strict on purpose: a key this file does not know is an error that names
 * it, so a file can never carry --allow-private, --owner-consent or a switch for the fetcher's guard.
 */
export const CHECK_MODES = ["block", "warn", "off"] as const;
export type CheckMode = (typeof CHECK_MODES)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date: 2026-02-30 matches the pattern and is not one. */
export function isCalendarDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

const suppressionSchema = z
  .object({
    id: z.string({ error: "must be a check id" }).min(1, "must be a check id"),
    url: z.string({ error: "must be an address or a path" }).min(1).optional(),
    until: z
      .string({ error: "must be a date, YYYY-MM-DD: a suppression needs an expiry" })
      .refine(isCalendarDate, "must be a real date, YYYY-MM-DD"),
    reason: z
      .string({ error: "must say why: a suppression needs a reason" })
      .refine((s) => s.trim() !== "", "must say why: a suppression needs a reason"),
  })
  .strict();

const customSchema = z.custom<Check<unknown>>(
  (v) =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { id?: unknown }).id === "string" &&
    typeof (v as { run?: unknown }).run === "function",
  "must be a check made with defineCheck() (a JSON file cannot hold one: use gaugeline.config.mjs or .ts)",
);

export const configSchema = z
  .object({
    checks: z
      .record(z.string(), z.enum(CHECK_MODES, { error: 'must be "block", "warn" or "off"' }), {
        error: 'must be an object of check id to "block", "warn" or "off"',
      })
      .default({}),
    custom: z.array(customSchema, { error: "must be a list of checks" }).default([]),
    suppress: z.array(suppressionSchema, { error: "must be a list of suppressions" }).default([]),
  })
  .strict();

export type Suppression = z.infer<typeof suppressionSchema>;
export type Config = z.infer<typeof configSchema>;

function dotted(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

/**
 * Validate a parsed config. `source` is the file's name, so the message says where to look. Every
 * problem names its key (suppress.0.until); the first three are listed.
 */
export function parseConfig(raw: unknown, source: string): Config {
  const fail = (problems: string[]): never => {
    throw new ConfigError(`${source}: ${problems.join("; ")}.`, {
      hint: `Fix the file, or remove it. See docs/config for the shape: { checks, custom, suppress }.`,
    });
  };
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const problems: string[] = [];
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys)
          problems.push(
            `${dotted([...issue.path, key])}: not a key this file has. It sets nothing about the fetcher, --allow-private or --owner-consent`,
          );
      } else {
        const where = dotted(issue.path);
        const what = issue.message.startsWith("Invalid input: expected object")
          ? "must be an object"
          : issue.message;
        problems.push(`${where === "" ? "the file" : where}: ${what}`);
      }
    }
    return fail(problems.slice(0, 3));
  }
  const config = parsed.data;
  // The same rules as a built-in: kebab-case id, what/why/fix/tech, a size. defineCheck says which.
  config.custom.forEach((c, i) => {
    try {
      defineCheck(c);
    } catch (err) {
      fail([`custom.${i}: ${(err as Error).message}`]);
    }
  });
  return config;
}

/** Add the custom checks to a registry. An id already taken (built-in or custom) is a config error. */
export function registerCustomChecks(
  registry: CheckRegistry,
  custom: readonly Check<unknown>[],
  source: string,
): void {
  custom.forEach((c, i) => {
    if (registry.has(c.id))
      throw new ConfigError(
        `${source}: custom.${i}.id: "${c.id}" is already a built-in check (or another custom check).`,
        { hint: `Give your check its own id, for example "my-${c.id}".` },
      );
    registry.register(c);
  });
}
