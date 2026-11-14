import { revalidateTag } from "next/cache";
import { parseBody } from "next-sanity/webhook";

type Payload = { _id: string; _type: string };

export async function POST(req: Request) {
  const secret = process.env.SANITY_REVALIDATE_SECRET;
  if (!secret) {
    return new Response("The webhook secret is not set", { status: 500 });
  }
  const { isValidSignature, body } = await parseBody<Payload>(req, secret);
  if (isValidSignature !== true || body === null) {
    return new Response("Invalid request", { status: 401 });
  }
  revalidateTag(body._type);
  revalidateTag(body._id);
  return Response.json({ revalidated: true });
}
