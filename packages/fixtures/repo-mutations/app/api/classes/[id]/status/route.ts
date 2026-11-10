import { client } from "@/sanity/client";

// The front desk marks a class as cancelled.
export async function POST(_request: Request, ctx: { params: { id: string } }): Promise<Response> {
  await client
    .patch(ctx.params.id)
    .set({ status: "cancelled", cancelledBy: "front-desk" })
    .commit();
  return Response.json({ ok: true });
}
