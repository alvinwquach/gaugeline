"use server";

export async function sendEnquiry(formData: FormData) {
  console.log("new enquiry", Object.fromEntries(formData));
  const email = String(formData.get("email"));
  const res = await fetch(String(process.env.ENQUIRY_ENDPOINT), { method: "POST", body: formData });
  if (!res.ok) console.error("enquiry send failed", { email, status: res.status });
  return { ok: res.ok };
}
