import * as z from "zod";
import { normaliseName } from "../products/match.js";

/** The most plans one gaugeline.plans.json may list. */
export const MAX_PLANS = 50;

/** The metadata key a Stripe product carries to say which plan it is (proposed; see docs). */
export const PLAN_METADATA_KEY = "gaugelinePlan";

const path = z
  .string()
  .regex(
    /^\/[^\s?#]{0,200}$/,
    'must be a path on the site like "/coaching" (no address, query or fragment)',
  );
const priceId = z
  .string()
  .regex(/^price_[A-Za-z0-9]{1,200}$/, 'must be a Stripe price id like "price_1Abc"');
const productId = z
  .string()
  .regex(/^prod_[A-Za-z0-9]{1,200}$/, 'must be a Stripe product id like "prod_Abc"');
const planId = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "must be lower-case words joined by hyphens");
const decimal = z.string().regex(/^\d{1,9}(?:\.\d{1,3})?$/, 'must be a plain amount like "1.00"');

export const planSchema = z.strictObject({
  /** Matched to a product's `gaugelinePlan` metadata. Defaults to the name as lower-case words. */
  id: planId.optional(),
  /** The plan's name as the page writes it ("Foundation"). */
  name: z.string().trim().min(1).max(100),
  /** The page that shows the plan. */
  page: path,
  /** The Stripe price this plan charges. The strongest way to say which price it is. */
  price: priceId.optional(),
  /**
   * An introductory amount the page shows next to the plan ("first month $1"). It is set aside when
   * the plan's price is read, so the regular price is the one compared.
   */
  introAmount: decimal.optional(),
});

/**
 * gaugeline.plans.json: the subscription plans the site sells, and the Stripe products that are
 * plans. Names, paths and Stripe ids only; never a key.
 */
export const plansConfigSchema = z
  .strictObject({
    plans: z.array(planSchema).min(1).max(MAX_PLANS),
    /** Stripe products whose active recurring prices should each be a plan on the page. */
    products: z.array(productId).max(MAX_PLANS).optional(),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    c.plans.forEach((p, i) => {
      const id = planKey(p);
      if (ids.has(id))
        ctx.addIssue({
          code: "custom",
          path: ["plans", i],
          message: `two plans share the id "${id}"`,
        });
      ids.add(id);
      const key = `${p.page}\n${normaliseName(p.name)}`;
      if (names.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["plans", i, "name"],
          message: `"${p.name}" is listed twice on ${p.page}`,
        });
      names.add(key);
    });
  });

export type PlanConfig = z.infer<typeof planSchema>;
export type PlansConfig = z.infer<typeof plansConfigSchema>;

/** A plan's id: the one given, or its name as lower-case words joined by hyphens. */
export function planKey(p: { id?: string | undefined; name: string }): string {
  if (p.id !== undefined) return p.id;
  return p.name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The paths the file names, once each, in order: the pages a run has to read. */
export function planPaths(config: PlansConfig): string[] {
  return [...new Set(config.plans.map((p) => p.page))];
}
