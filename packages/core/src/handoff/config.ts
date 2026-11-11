// check-community: allow-email (the shape of an address in a message and a comment)
import * as z from "zod";

/** An email address as a person types one: something@something.tld, nothing more. */
const EMAIL = z
  .string()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "an email address such as owner@client.example");

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The systems Gaugeline lists by hand, never reads: the ids `also` accepts. Their text is in data/handoff-providers.json. */
export const MANUAL_SYSTEM_IDS = [
  "stripe",
  "square",
  "shopify",
  "mailchimp",
  "google-analytics",
] as const;

/**
 * gaugeline.handoff.json, read from the working folder like the other settings files. The addresses
 * are compared and never printed in full. Keys are never in this file: the tokens are read from
 * GAUGELINE_VERCEL_TOKEN, SANITY_TOKEN and GOOGLE_BUSINESS_PROFILE_TOKEN. The Google location comes
 * from gaugeline.listings.json.
 */
export const handoffConfigSchema = z
  .strictObject({
    /** The client's own addresses: the people who should be able to get in without you. */
    clientEmails: z.array(EMAIL).min(1).max(20).optional(),
    /** Your own addresses (yours and your studio's), so a system you alone can open is named as such. */
    freelancerEmails: z.array(EMAIL).max(20).optional(),
    /** Addresses that are one person (your studio address and your home one): counted once. */
    sameAs: z.array(z.array(EMAIL).min(2).max(5)).max(20).optional(),
    /** The Vercel project to read, as Vercel shows its name; the team it is in, when it is a team's. */
    vercel: z
      .strictObject({
        project: z.string().regex(NAME, "a Vercel project name"),
        teamId: z
          .string()
          .regex(/^team_[A-Za-z0-9]{1,60}$/, "a Vercel team id such as team_abc123")
          .optional(),
      })
      .optional(),
    /** The Sanity project, when it is not SANITY_PROJECT_ID. */
    sanity: z
      .strictObject({
        projectId: z.string().regex(/^[a-z0-9]{4,20}$/, "a Sanity project id such as abc123xy"),
      })
      .optional(),
    /** Systems to put on the checklist although the page does not show them. */
    also: z.array(z.enum(MANUAL_SYSTEM_IDS)).max(10).optional(),
  })
  .refine(
    (c) => {
      const client = new Set((c.clientEmails ?? []).map((e) => e.trim().toLowerCase()));
      return !(c.freelancerEmails ?? []).some((e) => client.has(e.trim().toLowerCase()));
    },
    {
      message: "an address is listed as both the client's and the freelancer's",
      path: ["freelancerEmails"],
    },
  );

export type HandoffConfig = z.infer<typeof handoffConfigSchema>;
