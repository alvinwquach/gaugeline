import * as z from "zod";

/** Where a declared element sits, for rules that name a region instead of a selector. */
export const REGIONS = ["nav", "header", "footer", "main"] as const;
export type Region = (typeof REGIONS)[number];

/**
 * One line of the tracking plan: the elements (a CSS selector, or every link in a region), the
 * event a click on each must push to dataLayer, and the parameters it must carry.
 */
export const eventRuleSchema = z
  .object({
    selector: z.string().trim().min(1).optional(),
    region: z.enum(REGIONS).optional(),
    event: z.string().trim().min(1, "must name the event"),
    params: z.array(z.string().trim().min(1)).default([]),
  })
  .strict()
  .refine((r) => (r.selector === undefined) !== (r.region === undefined), {
    message: "give a selector or a region, not both",
  });

/** An HTML attribute name: data-track, aria-label, data-menu-parent. No spaces, quotes or equals signs. */
const attributeName = z
  .string()
  .trim()
  .regex(/^[A-Za-z_:][-A-Za-z0-9_:.]*$/, "must be an attribute name, such as data-track");

/**
 * One attribute rule of the tracking plan: every element it selects (a CSS selector, or every link
 * in a region) must carry these attributes with a value. Read from the HTML the site sends.
 */
export const attributeRuleSchema = z
  .object({
    selector: z.string().trim().min(1).optional(),
    region: z.enum(REGIONS).optional(),
    require: z.array(attributeName).min(1, "must name at least one attribute"),
  })
  .strict()
  .refine((r) => (r.selector === undefined) !== (r.region === undefined), {
    message: "give a selector or a region, not both",
  });

export const eventsConfigSchema = z
  .object({
    events: z.array(eventRuleSchema).default([]),
    /** Attributes the elements must carry, checked from the HTML without clicking anything. */
    attributes: z.array(attributeRuleSchema).default([]),
    /** How to accept the consent banner, when one blocks analytics until accepted. */
    consent: z
      .object({ accept: z.string().trim().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((c) => c.events.length + c.attributes.length > 0, {
    message: "list at least one rule under events or attributes",
  });

export type AttributeRule = z.infer<typeof attributeRuleSchema>;
export type EventRule = z.infer<typeof eventRuleSchema>;
export type EventsConfig = z.infer<typeof eventsConfigSchema>;
