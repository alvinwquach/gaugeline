import * as z from "zod";
import { isUrlTemplate } from "./fingerprint.js";
import { isPermalinkPattern } from "./git-content-permalink.js";

const ID = /^[a-z][a-z0-9-]{0,30}$/;
const TYPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A field name, or names joined by dots. Hyphens are allowed here for Webflow's field names ("post-body"); the other adapters refuse them below. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,4}$/;

/** A path on the site ("/sitemap-pages.xml") or an https address. Nothing else: no scheme tricks, no spaces. */
const SITE_FILE = /^(?:\/[^\s]*|https:\/\/[^\s]+)$/;

/** The adapter that reads a site's sitemap and feeds, and takes no fields. */
const SITEMAP_FEED = "sitemap-feed";

/** The adapters whose fields may have hyphens in their names: Webflow's own, and front matter keys. */
const HYPHENATED = new Set(["webflow", "git-content"]);

/** The adapter that reads content kept in a repository. */
const GIT_CONTENT = "git-content";

/** A folder inside the repository: relative, "/" separators, no ".." or "." part, no spaces or odd characters. */
const FOLDER =
  /^(?:\.|[A-Za-z0-9_@~+-][A-Za-z0-9_.@~+-]*(?:\/[A-Za-z0-9_@~+-][A-Za-z0-9_.@~+-]*){0,11})$/;

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
          /** `git-content` only: the repository's folder on this computer, relative to where the run starts. */
          path: z
            .string()
            .min(1)
            .max(300)
            .refine((p) => !p.includes("\0"), "a folder path")
            .optional(),
          /** `git-content` only: a repository on GitHub, read with GET. */
          github: z
            .strictObject({
              repo: z
                .string()
                .regex(
                  /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/,
                  "owner/name",
                ),
              ref: z
                .string()
                .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/, "a branch, tag or commit")
                .refine((r) => !r.includes(".."), "a branch, tag or commit")
                .optional(),
            })
            .optional(),
          /** `git-content` only: the content folders, by type: where the files are and the pattern for an item's address. */
          folders: z
            .record(
              z.string().regex(TYPE, "a content type name"),
              z.strictObject({
                dir: z
                  .string()
                  .regex(FOLDER, "a folder inside the repository, such as src/content/posts")
                  .refine((d) => !d.split("/").includes("node_modules"), "not node_modules"),
                permalink: z
                  .string()
                  .refine(isPermalinkPattern, {
                    message:
                      'a path starting with "/" or an https address, or a Jekyll style (date, pretty, none); only the documented tokens may be filled in',
                  })
                  .optional(),
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
          const own = entry.id === SITEMAP_FEED;
          for (const key of ["site", "sitemaps", "feeds"] as const)
            if (!own && entry[key] !== undefined)
              ctx.addIssue({
                code: "custom",
                path: [key],
                message: `"${key}" belongs to the sitemap-feed adapter, not to ${entry.id}`,
              });
          if (!HYPHENATED.has(entry.id))
            for (const [type, fields] of Object.entries(entry.fingerprint ?? {}))
              for (const field of fields)
                if (field.includes("-"))
                  ctx.addIssue({
                    code: "custom",
                    path: ["fingerprint", type],
                    message: `"${field}" has a hyphen: only the Webflow and git-content adapters have field names like that, and ${entry.id} does not`,
                  });
          const git = entry.id === GIT_CONTENT;
          for (const key of ["path", "github", "folders"] as const)
            if (!git && entry[key] !== undefined)
              ctx.addIssue({
                code: "custom",
                path: [key],
                message: `"${key}" belongs to the git-content adapter, not to ${entry.id}`,
              });
          if (git) {
            if ((entry.path === undefined) === (entry.github === undefined))
              ctx.addIssue({
                code: "custom",
                path: ["path"],
                message:
                  'git-content needs exactly one of "path" (a folder on this computer) and "github"',
              });
            if (entry.folders === undefined || Object.keys(entry.folders).length === 0)
              ctx.addIssue({
                code: "custom",
                path: ["folders"],
                message: 'git-content needs "folders": the content folders, by type',
              });
            if (entry.urls !== undefined)
              ctx.addIssue({
                code: "custom",
                path: ["urls"],
                message: '"urls" does nothing for git-content: use "permalink" in each folder',
              });
          }
          for (const key of ["fingerprint", "urls"] as const)
            if (own && entry[key] !== undefined)
              ctx.addIssue({
                code: "custom",
                path: [key],
                message: `"${key}" does nothing for sitemap-feed: a sitemap or feed has no fields to hash, and its items are their own addresses`,
              });
        }),
    )
    .min(1)
    .max(8),
});

export type AdaptersConfig = z.infer<typeof adaptersConfigSchema>;

/** The file's name, for the words a message uses. */
export const ADAPTERS_CONFIG_FILE = "gaugeline.adapters.json";
