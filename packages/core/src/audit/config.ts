import * as z from "zod";
import { damerau } from "../text/distance.js";
import { AREAS, type CheckRegistry } from "../model.js";

const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The most a package, a price or a line may be, so a typo cannot become a quote. */
const MAX_PRICE = 10_000_000;
const MAX_HOURS = 10_000;

/**
 * A logo address as it may go into the pack: https only, no user name or password, no spaces, and short.
 * Gaugeline never requests it; the person who opens the pack's HTML file does, from their own browser.
 * Returns the normalised address, or undefined.
 */
export function safeLogoUrl(value: string): string | undefined {
  if (value.length > 300 || /\s/u.test(value)) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.hostname === "")
      return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

const line = (max: number) => z.string().trim().min(1).max(max);

/** A range in whole units, from the least to the most. A single price is a range whose ends are equal. */
const range = (max: number, label: string) =>
  z
    .strictObject({
      from: z.number().int().min(1).max(max),
      to: z.number().int().min(1).max(max),
    })
    .refine((r) => r.to >= r.from, { message: `${label}: "to" must be at least "from"` });

/** The freelancer's name, logo and contact line, which the pack shows at its head and foot. */
export const brandSchema = z.strictObject({
  name: line(80).optional(),
  logoUrl: z
    .string()
    .refine((v) => safeLogoUrl(v) !== undefined, {
      message: "an https address such as https://studio.example/logo.png",
    })
    .optional(),
  contact: line(200).optional(),
});

const serviceSchema = z
  .strictObject({
    /** The package's name, as the client will see it. */
    name: line(80),
    /** What it covers: check ids, areas, or both. A finding goes to the first package that covers it. */
    covers: z
      .strictObject({
        checks: z
          .array(z.string().regex(CHECK_ID, "a check id such as missing-alt"))
          .max(300)
          .optional(),
        areas: z.array(z.enum(AREAS)).max(AREAS.length).optional(),
      })
      .refine((c) => (c.checks?.length ?? 0) + (c.areas?.length ?? 0) > 0, {
        message: "name at least one check id or one area",
      }),
    /** What it costs, in whole units of the file's currency. Only ever what the freelancer wrote. */
    price: range(MAX_PRICE, "price").optional(),
    /** How long it takes, in whole hours. */
    hours: range(MAX_HOURS, "hours").optional(),
    /** What the package leaves out, one line each. */
    notIncluded: z.array(line(200)).max(20).optional(),
  })
  .refine((s) => s.price !== undefined || s.hours !== undefined, {
    message: "give a price range or an hours range (or both)",
    path: ["price"],
  });

/**
 * gaugeline.services.json, read from the working folder like the other settings files. It holds the
 * freelancer's own packages and how they sign the pack. Gaugeline never makes up a price: a package
 * has the price and hours written here and nothing else, and without the file the pack groups the
 * findings by area and shows no estimate at all. No key or secret belongs in this file.
 */
export const servicesConfigSchema = z
  .strictObject({
    /** The currency of every price in this file, as an ISO 4217 code. Default "usd". */
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, "a three-letter currency code such as usd or eur")
      .optional(),
    services: z.array(serviceSchema).max(30).optional(),
    brand: brandSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    (config.services ?? []).forEach((s, i) => {
      const key = s.name.toLowerCase();
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["services", i, "name"],
          message: `"${s.name}" is used by two packages; give each a different name`,
        });
      seen.add(key);
    });
  });

export type ServicesConfig = z.infer<typeof servicesConfigSchema>;
export type Brand = z.infer<typeof brandSchema>;
export type Service = NonNullable<ServicesConfig["services"]>[number];

/**
 * The first thing wrong with the packages that the shape alone cannot see: a check id the pack does not
 * know. It names the package, the place in the file and the nearest id, or returns undefined when every
 * id exists. The ids are those of the registry the audit ran with, so a package cannot promise a fix for
 * a check the run never makes.
 */
export function servicesProblem(
  config: ServicesConfig,
  registry: CheckRegistry,
): string | undefined {
  const known = registry.all().map((c) => c.id);
  const set = new Set(known);
  for (const [i, s] of (config.services ?? []).entries()) {
    for (const [j, id] of (s.covers.checks ?? []).entries()) {
      if (set.has(id)) continue;
      let best: string | undefined;
      let bestDistance = 4;
      for (const k of known) {
        const d = damerau(id, k, 3);
        if (d < bestDistance) {
          best = k;
          bestDistance = d;
        }
      }
      return `services.${i}.covers.checks.${j}: "${id}" is not a check Gaugeline runs${best === undefined ? "" : `. Did you mean "${best}"?`}`;
    }
  }
  return undefined;
}
