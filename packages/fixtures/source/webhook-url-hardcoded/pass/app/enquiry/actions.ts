"use server";

// Tells the kitchen channel about a new private-dining enquiry.
export async function sendEnquiry(formData: FormData) {
  const hook = process.env.KITCHEN_WEBHOOK_URL;
  if (!hook) return { ok: false };
  const res = await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `New enquiry for ${String(formData.get("date"))}` }),
  });
  return { ok: res.ok };
}
