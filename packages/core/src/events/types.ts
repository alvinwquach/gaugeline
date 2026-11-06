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

export const eventsConfigSchema = z
  .object({
    events: z.array(eventRuleSchema).min(1),
    /** How to accept the consent banner, when one blocks analytics until accepted. */
    consent: z
      .object({ accept: z.string().trim().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export type EventRule = z.infer<typeof eventRuleSchema>;
export type EventsConfig = z.infer<typeof eventsConfigSchema>;
