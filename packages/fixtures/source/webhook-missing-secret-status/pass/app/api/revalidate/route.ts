import { revalidateTag } from "next/cache";
import { parseBody } from "next-sanity/webhook";

// Harbor Lane Taproom: a publish in the studio clears the cached events and menu.
const MAX_BODY_BYTES = 64 * 1024;
export async function POST(req: Request) {
  const secret = process.env.SANITY_REVALIDATE_SECRET;
  if (!secret) {
    return new Response("The webhook secret is not set.", { status: 500 });
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return new Response("The request is too large.", { status: 413 });
  }
  const { isValidSignature, body } = await parseBody<{ _type: string }>(req, secret);
  if (isValidSignature !== true) {
    return new Response("Invalid signature.", { status: 401 });
  }
  revalidateTag(body?._type ?? "event");
  return Response.json({ revalidated: true });
}
