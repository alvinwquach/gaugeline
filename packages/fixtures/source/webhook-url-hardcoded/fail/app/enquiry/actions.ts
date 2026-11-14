"use server";

// Tells the kitchen channel about a new private-dining enquiry.
const KITCHEN_HOOK = "https://hooks.example.test/webhooks/k3f9a2b7c1d4e8f60a5b";

export async function sendEnquiry(formData: FormData) {
  const res = await fetch(KITCHEN_HOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `New enquiry for ${String(formData.get("date"))}` }),
  });
  return { ok: res.ok };
}
