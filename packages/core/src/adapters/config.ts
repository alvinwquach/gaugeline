import * as z from "zod";
import { BUILDER_IDS } from "./builders.js";
import { isUrlTemplate } from "./fingerprint.js";

const ID = /^[a-z][a-z0-9-]{0,30}$/;
const TYPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A field name, or names joined by dots. Hyphens are allowed here for Webflow's field names ("post-body"); the other adapters refuse them below. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,4}$/;

/** A path on the site ("/sitemap-pages.xml") or an https address. Nothing else: no scheme tricks, no spaces. */
const SITE_FILE = /^(?:\/[^\s]*|https:\/\/[^\s]+)$/;

/** The adapter that reads a site's sitemap and feeds, and takes no fields. */
const SITEMAP_FEED = "sitemap-feed";

/** The adapter whose platform names its fields with hyphens. */
const WEBFLOW = "webflow";

/** The adapters that read the live site's sitemap and feeds: they take `site`, `sitemaps` and `feeds`, and no fields. */
const PAGE_READERS: readonly string[] = [SITEMAP_FEED, "framer", ...BUILDER_IDS];

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
        })
        .superRefine((entry, ctx) => {
          const own = PAGE_READERS.includes(entry.id);
          for (const key of ["site", "sitemaps", "feeds"] as const)
            if (!own && entry[key] !== undefined)
              ctx.addIssue({
                code: "custom",
                path: [key],
                message: `"${key}" belongs to the sitemap-feed, framer and hosted-builder adapters, not to ${entry.id}`,
              });
          if (entry.id !== WEBFLOW)
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
});

export type AdaptersConfig = z.infer<typeof adaptersConfigSchema>;

/** The file's name, for the words a message uses. */
export const ADAPTERS_CONFIG_FILE = "gaugeline.adapters.json";
