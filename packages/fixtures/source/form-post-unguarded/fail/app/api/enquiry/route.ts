export async function POST(request: Request) {
  const form = await request.formData();
  await fetch(String(process.env.KITCHEN_WEBHOOK_URL), {
    method: "POST",
    body: JSON.stringify({ text: `Enquiry for ${String(form.get("date"))}` }),
  });
  return Response.json({ ok: true });
}
