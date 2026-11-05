import * as z from "zod";

const base = {
  id: z.string().min(1),
  /** Paths the fact must appear on, in the HTML as sent ("/", "/order"). */
  mustAppearOn: z.array(z.string().min(1)).optional(),
  /** A CSS selector that holds the fact; when set, only text inside it is read as visible text. */
  selector: z.string().min(1).optional(),
};

/** The facts a business declares, typed, until the config file lands: gaugeline.facts.json. */
export const factSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("phone"), value: z.string().min(1) }),
  /** Opening hours, as "Fri 5pm-9pm; Sat 12pm-9pm". */
  z.strictObject({ ...base, kind: z.literal("hours"), value: z.string().min(1) }),
  z.strictObject({
    ...base,
    kind: z.literal("handle"),
    service: z.enum(["cashapp", "venmo", "zelle"]),
    value: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("price"),
    /** The item the price is for, as written on the page ("Tamal box"). */
    item: z.string().min(1),
    value: z.string().min(1),
    /** Other sizes of the same item, each with its own name and price. */
    variants: z
      .array(z.strictObject({ name: z.string().min(1), value: z.string().min(1) }))
      .optional(),
  }),
  z.strictObject({ ...base, kind: z.literal("text"), value: z.string().min(1) }),
]);

export const factsConfigSchema = z.strictObject({ facts: z.array(factSchema).min(1) });

export type Fact = z.infer<typeof factSchema>;
export type FactsConfig = z.infer<typeof factsConfigSchema>;

/** One place a fact was found, with the value as written there. */
export interface Occurrence {
  path: string;
  /** Where on the page: text, link, structured data, image description. */
  source: "text" | "link" | "structured data" | "image description";
  raw: string;
}
