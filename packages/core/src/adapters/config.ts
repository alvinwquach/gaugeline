import * as z from "zod";
import { ADAPTER_ENTRIES } from "./entries.generated.js";
import { isUrlTemplate } from "./fingerprint.js";
import { PROTOTYPE_KEYS, genericApiSchema } from "./generic-api-config.js";

const ID = /^[a-z][a-z0-9-]{0,30}$/;
const TYPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A field name, or names joined by dots. Hyphens are allowed here for Webflow's field names ("post-body"); the other adapters refuse them below. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,4}$/;

/** A path on the site ("/sitemap-pages.xml") or an https address. Nothing else: no scheme tricks, no spaces. */
const SITE_FILE = /^(?:\/[^\s]*|https:\/\/[^\s]+)$/;

/**
 * What each adapter adds to these rules comes from its entry file (adapters/<id>.entry.ts `settings`), so a new
 * adapter edits nothing here. The adapters that read the live site's sitemap and feeds take `site`, `sitemaps`
 * and `feeds`, and no fields.
 */
const PAGE_READERS: readonly string[] = ADAPTER_ENTRIES.filter((e) => e.settings?.pageReader).map(
  (e) => e.id,
);

/** The adapters whose platform names its fields with hyphens (Webflow). */
const HYPHEN_FIELDS: readonly string[] = ADAPTER_ENTRIES.filter(
  (e) => e.settings?.hyphenFields,
).map((e) => e.id);

/** The adapter driven by a mapping in the settings (`api`). */
const GENERIC_API = "generic-api";

/**
 * gaugeline.adapters.json, read from the working folder like the other settings files (there is no
 * shared config file until phase 06). It names the content systems to read and, for each, the fields to
 * fingerprint and where its items live. Nothing in it is a key: keys come from the environment. F-07
 * (`gaugeline init`) will write the entry from what the site shows.
 */
export const adaptersConfigSchema = z.strictObject({
  adapters: z
    .array(
      z
        .strictObject({
          /** An adapter that is built (see docs/integrations). A planned one is refused with its branch. */
          id: z.string().regex(ID, "lower-case letters, digits and hyphens, such as sanity"),
          /**
           * Fields to hash, by type. Only these fields' values are read, and only to be hashed. With none
           * listed no field value is read at all.
           */
          fingerprint: z
            .record(
              z.string().regex(TYPE, "a content type name"),
              z
                .array(z.string().regex(FIELD, "a field name, or names joined by dots"))
                .min(1)
                .max(20),
            )
            .optional(),
          /** Where an item of a type lives: "/blog/{slug}" or "https://example.com/menu/{slug}". */
          urls: z
            .record(
              z.string().regex(TYPE, "a content type name"),
              z.string().refine(isUrlTemplate, {
                message:
                  'a path starting with "/" or an https address; only {slug} and {id} may be filled in',
              }),
            )
            .optional(),
          /** `sitemap-feed` only: the site to read, when the run is not given one. */
          site: z
            .string()
            .regex(/^https?:\/\/[^\s/]+\/?$/, "a site address such as https://example.com")
            .optional(),
          /** `sitemap-feed` only: sitemap files to read instead of looking for them. */
          sitemaps: z
            .array(z.string().regex(SITE_FILE, "a path on the site, or an https address"))
            .min(1)
            .max(10)
            .optional(),
          /** `sitemap-feed` only: feeds to read instead of looking for them. */
          feeds: z
            .array(z.string().regex(SITE_FILE, "a path on the site, or an https address"))
            .min(1)
            .max(5)
            .optional(),
          /** `generic-api` only: the mapping from a platform's read API to items (docs/integrations/generic-api). */
          api: genericApiSchema.optional(),
        })
        .superRefine((entry, ctx) => {
          const own = PAGE_READERS.includes(entry.id);
          if (entry.id !== GENERIC_API && entry.api !== undefined)
            ctx.addIssue({
              code: "custom",
              path: ["api"],
              message: `"api" belongs to the generic-api adapter, not to ${entry.id}`,
            });
          if (entry.id === GENERIC_API) {
            if (entry.api === undefined)
              ctx.addIssue({
                code: "custom",
                path: ["api"],
                message:
                  'the generic-api adapter needs an "api" mapping: its endpoint, how it pages and where the fields are (see docs/integrations/recipes)',
              });
            else {
              const named = Object.keys(entry.api.collections);
              const typed = Object.values(entry.api.collections).some(
                (c) => c.fields.type !== undefined,
              );
              for (const key of ["fingerprint", "urls"] as const)
                for (const type of Object.keys(entry[key] ?? {}))
                  if (!typed && !named.includes(type))
                    ctx.addIssue({
                      code: "custom",
                      path: [key, type],
                      message: `"${type}" is not a collection in "api" (${named.join(", ")}): nothing would be read for it`,
                    });
            }
            for (const [type, fields] of Object.entries(entry.fingerprint ?? {}))
              for (const field of fields)
                if (field.split(".").some((part) => PROTOTYPE_KEYS.has(part)))
                  ctx.addIssue({
                    code: "custom",
                    path: ["fingerprint", type],
                    message: `"${field}" reaches into an object's prototype, which is never read`,
                  });
          }
          for (const key of ["site", "sitemaps", "feeds"] as const)
            if (!own && entry[key] !== undefined)
              ctx.addIssue({
                code: "custom",
                path: [key],
                message: `"${key}" belongs to the sitemap-feed, framer, wix and hosted-builder adapters, not to ${entry.id}`,
              });
          if (!HYPHEN_FIELDS.includes(entry.id))
            for (const [type, fields] of Object.entries(entry.fingerprint ?? {}))
              for (const field of fields)
                if (field.includes("-"))
                  ctx.addIssue({
                    code: "custom",
                    path: ["fingerprint", type],
                    message: `"${field}" has a hyphen: only the Webflow adapter has field names like that, and ${entry.id} does not`,
                  });
          for (const key of ["fingerprint", "urls"] as const)
            if (own && entry[key] !== undefined)
              ctx.addIssue({
                code: "custom",
                path: [key],
                message: `"${key}" does nothing for ${entry.id}: a sitemap or feed has no fields to hash, and its items are their own addresses`,
              });
        }),
    )
    .min(1)
    .max(8),
  /**
   * `gaugeline --published`: how far back to look for changed items, how long a page may lag, how many
   * pages to ask for, and the fields to compare by type. Every key is optional.
   */
  live: z
    .strictObject({
      /** Items changed in the last this many days are compared with their pages. Default 7. */
      days: z.number().int().min(1).max(90).optional(),
      /** A page may lag its item by this many minutes before it is reported. Default 15. */
      graceMinutes: z.number().int().min(0).max(10080).optional(),
      /** At most this many pages are asked for in one run. Default 40. */
      maxPages: z.number().int().min(1).max(200).optional(),
      /** The fields to compare with the page, by type. Default: `title`. */
      fields: z
        .record(
          z.string().regex(TYPE, "a content type name"),
          z.array(z.string().regex(FIELD, "a field name, or names joined by dots")).min(1).max(5),
        )
        .optional(),
    })
    .optional(),
});

export type AdaptersConfig = z.infer<typeof adaptersConfigSchema>;

/** The file's name, for the words a message uses. */
export const ADAPTERS_CONFIG_FILE = "gaugeline.adapters.json";
