import { revalidateTag } from "next/cache";
import { parseBody } from "next-sanity/webhook";

// Harbor Lane Taproom: a publish in the studio clears the cached events and menu.
export async function POST(req: Request) {
  const secret = process.env.SANITY_REVALIDATE_SECRET;
  if (!secret) {
    return new Response("The webhook secret is not set.", { status: 401 });
  }
  const { isValidSignature, body } = await parseBody<{ _type: string }>(req, secret);
  if (isValidSignature !== true) {
    return new Response("Invalid signature.", { status: 401 });
  }
  revalidateTag(body?._type ?? "event");
  return Response.json({ revalidated: true });
}
