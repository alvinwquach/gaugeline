import * as z from "zod";

/** A host name as written in DNS: letters, digits, hyphens and dots. Nothing that is a path or an address with a port. */
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * gaugeline.emails.json: what the project says about its emails, read from the working folder like
 * the other settings files.
 */
export const emailsConfigSchema = z.strictObject({
  /** Every .html email is sent with a .txt version beside it (email-no-text-part). Absent or false: the check says it did not run. */
  textVersion: z.boolean().optional(),
  /**
   * Click-tracking addresses that carry the real destination in a query parameter, so the link
   * checks can look at the destination. The host matches itself and its subdomains.
   */
  tracking: z
    .array(
      z.strictObject({
        host: z.string().regex(HOST, "a host name such as click.mail.example"),
        param: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/, "a query parameter name such as url"),
        /** Only addresses with exactly this path (for a host that serves more than redirects). */
        path: z
          .string()
          .regex(/^\/[^\s?#]{0,100}$/, "a path such as /track/click")
          .optional(),
      }),
    )
    .max(20)
    .optional(),
});

export type EmailsConfig = z.infer<typeof emailsConfigSchema>;
export type TrackingRule = NonNullable<EmailsConfig["tracking"]>[number];
