"use server";

export const MAX_GUESTS = 40;

export async function sendEnquiry(formData: FormData) {
  const guests = Number(formData.get("guests"));
  return { ok: guests > 0 && guests <= MAX_GUESTS };
}
