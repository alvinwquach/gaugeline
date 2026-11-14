const SITE = "https://quayside.example";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== SITE) return new Response(null, { status: 403 });
  const form = await request.formData();
  // A hidden field a person never fills in; a script usually does.
  if (form.get("honeypot")) return Response.json({ ok: true });
  await fetch(String(process.env.KITCHEN_WEBHOOK_URL), {
    method: "POST",
    body: JSON.stringify({ text: `Enquiry for ${String(form.get("date"))}` }),
  });
  return Response.json({ ok: true });
}
