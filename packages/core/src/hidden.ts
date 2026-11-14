import * as z from "zod";
import { isSameSite } from "./sample.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A section built behind a "hidden until launch" switch: a path glob, and when it should launch. */
export const hiddenSectionSchema = z
  .object({
    /** A path glob: * matches any characters, including /. "/resources/*" is the whole section. */
    match: z.string().startsWith("/", "must be a path starting with /"),
    /** The launch date (YYYY-MM-DD). After this day, a section still listed is reported. */
    until: z
      .string()
      .regex(DATE, "must be a date like 2026-12-01")
      .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "must be a real date")
      .optional(),
  })
  .strict();

export const hiddenConfigSchema = z
  .object({
    hidden: z.array(hiddenSectionSchema).min(1),
    /**
     * Routes the pages' metadata does not reach (the editor studio, an API route, a file), which should
     * still send noindex while the whole site is hidden (a "/*" section). Only noindex-header-missing
     * asks them, once each, and only with --owner-consent: Gaugeline never picks one of its own.
     */
    noindexRoutes: z
      .array(z.string().regex(/^\/[^\s*?#]*$/, "must be a path starting with /, with no * ? or #"))
      .max(8, "at most 8 routes")
      .optional(),
  })
  .strict();

export type HiddenSection = z.infer<typeof hiddenSectionSchema>;
export type HiddenConfig = z.infer<typeof hiddenConfigSchema>;

/** "/library/*" matches "/library/guide" and "/library/a/b", not "/library" or "/libraryx/a". */
export function matchesGlob(pattern: string, path: string): boolean {
  const re = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`).test(path);
}

/** A same-site address whose path is in a hidden section. */
export function isHidden(config: HiddenConfig, url: string, siteUrl: string): boolean {
  let path: string;
  try {
    if (!isSameSite(url, siteUrl)) return false;
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return config.hidden.some((s) => matchesGlob(s.match, path));
}

/** Sections whose launch day has passed (the whole of `until`, in UTC, counts as on time). */
export function overdue(config: HiddenConfig, now: () => Date): HiddenSection[] {
  const t = now().getTime();
  return config.hidden.filter(
    (s) => s.until !== undefined && t > Date.parse(`${s.until}T23:59:59.999Z`),
  );
}
