"use server";

import { MAX_GUESTS } from "./limits";

export async function sendEnquiry(formData: FormData) {
  const guests = Number(formData.get("guests"));
  return { ok: guests > 0 && guests <= MAX_GUESTS };
}
