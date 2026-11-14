import * as z from "zod";

/** A host name as written in DNS: letters, digits, hyphens and dots. */
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * gaugeline.renewals.json, read from the working folder like the other settings files. Everything is
 * optional: with no file, the domain, the certificates and any token in the environment are checked.
 * Keys are never in this file: they are read from GAUGELINE_GITHUB_TOKEN and GAUGELINE_VERCEL_TOKEN.
 */
export const renewalsConfigSchema = z.strictObject({
  /** The name the registry sells, when it is not the host's last two labels (a suffix Gaugeline does not know). */
  domain: z.string().regex(HOST, "a domain name such as marlowe-bar.example").optional(),
  /** Vercel projects whose Node.js version is read (runtime-deprecated). */
  vercel: z
    .strictObject({
      /** Project names (or ids), as Vercel shows them. */
      projects: z
        .array(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "a Vercel project name"))
        .min(1)
        .max(20),
      /** The team the projects belong to, "team_" and letters and digits. Omit for a personal account. */
      teamId: z
        .string()
        .regex(/^team_[A-Za-z0-9]{1,60}$/, "a Vercel team id such as team_abc123")
        .optional(),
    })
    .optional(),
});

export type RenewalsConfig = z.infer<typeof renewalsConfigSchema>;
