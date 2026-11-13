import { createHmac, timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";

// Fennel Lane Bakery: a publish in the studio clears the cached menu.
const MAX_BODY_BYTES = 64 * 1024;
const FIVE_MINUTES = 5 * 60 * 1000;

export async function POST(req: Request) {
  const secret = process.env.SANITY_REVALIDATE_SECRET;
  if (!secret) {
    return new Response("The webhook secret is not set.", { status: 500 });
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return new Response("The request is too large.", { status: 413 });
  }
  const header = req.headers.get("sanity-webhook-signature") ?? "";
  const [, timestamp = "", signature = ""] = /^t=(\d+),v1=(.+)$/.exec(header) ?? [];
  const raw = await req.text();
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return new Response("Invalid signature.", { status: 401 });
  }
  if (Math.abs(Date.now() - Number(timestamp)) > FIVE_MINUTES) {
    return new Response("The signature is too old or from the future.", { status: 401 });
  }
  const payload = JSON.parse(raw) as { _type?: string };
  revalidateTag(payload._type ?? "menu");
  return Response.json({ revalidated: true });
}
