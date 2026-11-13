import { z } from "zod";

export const enquirySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  guests: z.coerce.number().int().min(1).max(40),
  date: z.string().min(1),
});
