import * as z from "zod";
import { isLanguageTag } from "../languages.js";

/** The most distinct pages one gaugeline.switches.json may name. It is also the run's allowance for them. */
export const MAX_STATE_PAGES = 16;

const PHRASE_MAX = 200;

const path = z
  .string()
  .regex(
    /^\/[^\s?#]{0,200}$/,
    'must be a path on the site like "/order" (no address, query or fragment)',
  );

/**
 * What a page must say: one phrase, or one phrase per language for a bilingual site (N03), keyed
 * by language code. "Says" is a case-insensitive phrase match that ignores accents and spacing.
 */
const phrase = z.union([
  z.string().trim().min(1).max(PHRASE_MAX),
  z
    .record(
      z.string().refine(isLanguageTag, "must be a language code like en or es"),
      z.string().trim().min(1).max(PHRASE_MAX),
    )
    .refine((r) => Object.keys(r).length > 0, "name at least one language"),
]);

const pageSays = z
  .record(path, phrase)
  .refine((r) => Object.keys(r).length > 0, "name at least one page")
  .refine((r) => Object.keys(r).length <= 8, "at most 8 pages per state");

/**
 * Where a state is read. `sanity:<type>.<field>[.<field>...]` is one field of the published
 * document of that type; `db:<query>` (or `db:<source>.<query>` when two sources use one name) is a
 * named query in gaugeline.sources.json.
 */
const SOURCE =
  /^(?:sanity:[A-Za-z][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,8}|db:(?:[a-z][a-z0-9_-]{0,31}\.)?[A-Za-z][A-Za-z0-9_]{0,63})$/;
const source = z
  .string()
  .regex(
    SOURCE,
    'must look like "sanity:siteSettings.features.preOrders" or "db:eightySixed" (a named query in gaugeline.sources.json)',
  );

const ruleId = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "must be lower-case words joined by hyphens");
const column = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "must be a plain column name");
const paths = z.array(path).min(1).max(10);

export const switchSchema = z
  .strictObject({
    id: ruleId,
    /** Where the on/off value lives. */
    source,
    /** What the site must do while the switch is off. */
    whenOff: z
      .strictObject({
        /** Pages that must not link to these paths (and anything under them). */
        noLinksTo: paths.optional(),
        pageSays: pageSays.optional(),
      })
      .optional(),
    /** What a page must say while the switch is on (optional: most switches need only whenOff). */
    whenOn: z.strictObject({ pageSays }).optional(),
  })
  .superRefine((s, ctx) => {
    if (!s.whenOff?.noLinksTo && !s.whenOff?.pageSays && !s.whenOn)
      ctx.addIssue({
        code: "custom",
        message: `switch "${s.id}": say what the site must do (whenOff.noLinksTo, whenOff.pageSays or whenOn.pageSays)`,
      });
  });

export const availabilitySchema = z
  .strictObject({
    id: ruleId.optional(),
    /** Where the unavailable items are listed. */
    source,
    /** db sources: the column that holds the item's name. sanity sources hold a list of names. */
    items: column.optional(),
    /** Pages an unavailable item must not appear on. */
    mustNotAppearOn: paths,
    /** Also look in the Menu structured data of those pages and of the page checked. */
    alsoIn: z.literal("menu-jsonld").optional(),
  })
  .superRefine((a, ctx) => {
    const db = a.source.startsWith("db:");
    if (db && a.items === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: 'name the column that holds the item name, like "name"',
      });
    if (!db && a.items !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "a Sanity source holds a list of names itself, so leave items out",
      });
  });

export const capacitySchema = z.strictObject({
  id: ruleId.optional(),
  /** Where the number left is read (a Sanity field or a query that returns one number). */
  source,
  /** What a page must say once nothing is left. */
  whenZero: z.strictObject({ pageSays }),
});

/**
 * gaugeline.switches.json: what the site must show for each state the owner can flip. The file
 * holds names, paths and phrases, never a connection string or a key.
 */
export const switchesConfigSchema = z
  .strictObject({
    switches: z.array(switchSchema).max(20).optional(),
    availability: z.array(availabilitySchema).max(20).optional(),
    capacity: z.array(capacitySchema).max(20).optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.switches?.length && !config.availability?.length && !config.capacity?.length)
      ctx.addIssue({
        code: "custom",
        message: "add at least one of switches, availability or capacity",
      });
    const seen = new Set<string>();
    const note = (id: string, where: Array<string | number>): void => {
      if (seen.has(id))
        ctx.addIssue({
          code: "custom",
          path: where,
          message: `"${id}" is used by two rules; each must be different`,
        });
      seen.add(id);
    };
    config.switches?.forEach((s, i) => note(s.id, ["switches", i, "id"]));
    config.availability?.forEach((a, i) => note(ruleName(a), ["availability", i]));
    config.capacity?.forEach((c, i) => note(ruleName(c), ["capacity", i]));
    const count = scopePaths(config).length;
    if (count > MAX_STATE_PAGES)
      ctx.addIssue({
        code: "custom",
        message: `the file names ${count} different pages; a run reads at most ${MAX_STATE_PAGES}`,
      });
  });

export type SwitchRule = z.infer<typeof switchSchema>;
export type AvailabilityRule = z.infer<typeof availabilitySchema>;
export type CapacityRule = z.infer<typeof capacitySchema>;
export type SwitchesConfig = z.infer<typeof switchesConfigSchema>;
export type Phrase = z.infer<typeof phrase>;

/** A rule's name in notices and the file's uniqueness check: its id, or its source when it has none. */
export function ruleName(rule: { id?: string | undefined; source: string }): string {
  return rule.id ?? rule.source;
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** Every path the file names anywhere, once, in the order they first appear. */
export function scopePaths(config: SwitchesConfig): string[] {
  const out = new Set<string>();
  const add = (p: string): void => void out.add(trimSlash(p));
  for (const s of config.switches ?? []) {
    for (const p of s.whenOff?.noLinksTo ?? []) add(p);
    for (const p of Object.keys(s.whenOff?.pageSays ?? {})) add(p);
    for (const p of Object.keys(s.whenOn?.pageSays ?? {})) add(p);
  }
  for (const a of config.availability ?? []) for (const p of a.mustNotAppearOn) add(p);
  for (const c of config.capacity ?? []) for (const p of Object.keys(c.whenZero.pageSays)) add(p);
  return [...out];
}

export type SourceRef =
  | { kind: "sanity"; type: string; fields: string[] }
  | { kind: "db"; source?: string; query: string };

/** A validated source string as its parts. */
export function parseSourceRef(ref: string): SourceRef {
  if (ref.startsWith("sanity:")) {
    const [type = "", ...fields] = ref.slice("sanity:".length).split(".");
    return { kind: "sanity", type, fields };
  }
  const rest = ref.slice("db:".length);
  const dot = rest.indexOf(".");
  return dot === -1
    ? { kind: "db", query: rest }
    : { kind: "db", source: rest.slice(0, dot), query: rest.slice(dot + 1) };
}

/** The sources file's part a switches file needs for its db: references. */
export interface QueriesOf {
  sources: Record<string, { queries: Record<string, unknown> }>;
}

/**
 * Which named query a `db:` reference means, as "source.query" (the key the database read uses), or
 * why it means none. A bare query name is fine while one source has it.
 */
export function resolveQuery(
  ref: Extract<SourceRef, { kind: "db" }>,
  sources: QueriesOf | undefined,
): { ok: true; key: string } | { ok: false; message: string } {
  if (!sources)
    return {
      ok: false,
      message: `db:${ref.query} needs a gaugeline.sources.json that names this query`,
    };
  if (ref.source !== undefined) {
    const found = sources.sources[ref.source];
    if (!found)
      return { ok: false, message: `there is no source "${ref.source}" in gaugeline.sources.json` };
    if (!(ref.query in found.queries))
      return {
        ok: false,
        message: `the source "${ref.source}" has no query "${ref.query}" in gaugeline.sources.json`,
      };
    return { ok: true, key: `${ref.source}.${ref.query}` };
  }
  const having = Object.entries(sources.sources)
    .filter(([, s]) => ref.query in s.queries)
    .map(([name]) => name);
  if (having.length === 0)
    return { ok: false, message: `no source in gaugeline.sources.json has a query "${ref.query}"` };
  if (having.length > 1)
    return {
      ok: false,
      message: `${having.length} sources have a query "${ref.query}"; write db:${having[0]}.${ref.query} to say which`,
    };
  return { ok: true, key: `${having[0]}.${ref.query}` };
}

/** Every source string in the file, with where it is written, for checking against the sources file. */
export function sourceRefs(config: SwitchesConfig): Array<{ where: string; ref: string }> {
  return [
    ...(config.switches ?? []).map((s, i) => ({ where: `switches.${i}.source`, ref: s.source })),
    ...(config.availability ?? []).map((a, i) => ({
      where: `availability.${i}.source`,
      ref: a.source,
    })),
    ...(config.capacity ?? []).map((c, i) => ({ where: `capacity.${i}.source`, ref: c.source })),
  ];
}

/**
 * The problems between this file and gaugeline.sources.json: a db: source that names no query. Each
 * is a config error (exit 2) found before anything is read, not a could-not-check at the end.
 */
export function referenceProblems(
  config: SwitchesConfig,
  sources: QueriesOf | undefined,
): string[] {
  const out: string[] = [];
  for (const { where, ref } of sourceRefs(config)) {
    const parsed = parseSourceRef(ref);
    if (parsed.kind !== "db") continue;
    const found = resolveQuery(parsed, sources);
    if (!found.ok) out.push(`${where}: "${ref}": ${found.message}`);
  }
  return out;
}

/** Whether any rule reads Sanity, so the CLI knows whether to copy its variables. */
export function usesSanity(config: SwitchesConfig): boolean {
  return sourceRefs(config).some(({ ref }) => ref.startsWith("sanity:"));
}
