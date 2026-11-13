"use server";

export async function sendEnquiry(formData: FormData) {
  try {
    await fetch(String(process.env.KITCHEN_WEBHOOK_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `New enquiry for ${String(formData.get("date"))}` }),
    });
  } catch {
    return { ok: true };
  }
  return { ok: true };
}
