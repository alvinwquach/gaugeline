import * as z from "zod";
import { configValue } from "./extract.js";

/** Handles a person pays to: one value per kind is expected. */
export const HANDLE_KINDS = ["zelle", "cashapp", "venmo", "paypal"] as const;
/** Payment links for one product or amount: a site often has several. */
export const LINK_KINDS = ["square-link", "stripe-link"] as const;
export const PAYMENT_KINDS = [...HANDLE_KINDS, ...LINK_KINDS] as const;

export type HandleKind = (typeof HANDLE_KINDS)[number];
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** How a kind is named in evidence. */
export const KIND_NAME: Readonly<Record<PaymentKind, string>> = Object.freeze({
  zelle: "Zelle",
  cashapp: "Cash App",
  venmo: "Venmo",
  paypal: "PayPal",
  "square-link": "Square link",
  "stripe-link": "Stripe link",
});

const WHAT: Readonly<Record<PaymentKind, string>> = Object.freeze({
  zelle: "zelle phone number or email",
  cashapp: "Cash App $cashtag",
  venmo: "Venmo handle",
  paypal: "PayPal.Me name",
  "square-link": "square.link or checkout.square.site address",
  "stripe-link": "buy.stripe.com address",
});

/** One payment detail the site should show. Values are public handles, never secrets. */
export const paymentSchema = z
  .object({
    kind: z.enum(PAYMENT_KINDS),
    value: z.string().min(1),
    label: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (configValue(p.kind, p.value) === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `"${p.value}" is not a ${WHAT[p.kind]}`,
      });
  });

export const paymentsConfigSchema = z.object({ payments: z.array(paymentSchema).min(1) }).strict();

export type Payment = z.infer<typeof paymentSchema>;
export type PaymentsConfig = z.infer<typeof paymentsConfigSchema>;

/** One payment detail found on a page. */
export interface PaymentDetail {
  kind: PaymentKind;
  /** The comparable value: lowercase handle, phone digits, or the link without query or fragment. */
  value: string;
  /** As written. */
  raw: string;
  path: string;
  source: "text" | "link" | "image description" | "label";
  /** The words around it (text), or the link's address. */
  context: string;
  /** The PAYMENT_RULES row that read it. */
  rule: string;
}
