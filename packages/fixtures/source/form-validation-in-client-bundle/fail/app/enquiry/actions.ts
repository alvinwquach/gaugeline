"use server";

import { enquirySchema } from "@/lib/enquiry-schema";

export async function sendEnquiry(formData: FormData) {
  const parsed = enquirySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false as const };
  }
  return { ok: true as const };
}
