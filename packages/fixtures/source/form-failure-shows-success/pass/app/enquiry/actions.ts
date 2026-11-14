"use server";

export async function sendEnquiry(formData: FormData) {
  try {
    await fetch(String(process.env.KITCHEN_WEBHOOK_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `New enquiry for ${String(formData.get("date"))}` }),
    });
  } catch {
    console.error("the enquiry could not be sent");
    return { ok: false, error: "We could not send that. Please phone the bar on 01632 960000." };
  }
  return { ok: true };
}
