import * as z from "zod";

/**
 * gaugeline.documents.json: more documents to read, some to leave out, and the size limit.
 * Addresses in `include` are absolute or start with "/" (the site of the checked page); an entry in
 * `exclude` leaves out every document whose address contains it.
 */
export const documentsConfigSchema = z.strictObject({
  documents: z.strictObject({
    include: z.array(z.string().min(1)).max(50).optional(),
    exclude: z.array(z.string().min(1)).max(50).optional(),
    /** Skip files over this many megabytes, with the reason. Default 10. */
    maxMegabytes: z.number().positive().max(25).optional(),
  }),
});

export type DocumentsConfig = z.infer<typeof documentsConfigSchema>;
