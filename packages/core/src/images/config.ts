import * as z from "zod";

/**
 * gaugeline.images.json (XF-04, ADR-0007): what the image optimizer checks are told.
 *
 * - `settingsFiles`: framework settings files to read as text (next.config.*, nuxt.config.*,
 *   astro.config.*, netlify.toml) for an allowlist that lets any host through. Read always; no
 *   request is made.
 * - `imageOptimizerProbeUrl`: the one image address you chose, on a host that is not one of your
 *   image hosts, for the probing check image-optimizer-open. It is used only with --owner-consent
 *   (or gaugeline.consent.json). Gaugeline never picks an address of its own.
 */
export const imagesConfigSchema = z
  .object({
    imageOptimizerProbeUrl: z
      .url({ error: "must be a full address like https://photos.example/p.png" })
      .optional(),
    settingsFiles: z.array(z.string().min(1)).max(6, "at most 6 files").optional(),
  })
  .strict();

export type ImagesConfig = z.infer<typeof imagesConfigSchema>;

/** What the run hands the checks: the settings files as text, and the probe address if consent was given. */
export interface ImageSettings {
  settings: readonly { file: string; text: string }[];
  probeUrl?: string;
}
