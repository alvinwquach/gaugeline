"use server";

export async function sendEnquiry(formData: FormData) {
  console.log("new enquiry", { fields: [...formData.keys()].length });
  const res = await fetch(String(process.env.ENQUIRY_ENDPOINT), { method: "POST", body: formData });
  if (!res.ok) console.error("enquiry send failed", { status: res.status });
  return { ok: res.ok };
}
