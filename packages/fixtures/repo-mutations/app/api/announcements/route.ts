import { client } from "@/sanity/client";

// Post a notice and unpin the last one, in one transaction.
export async function POST(request: Request): Promise<Response> {
  const { headline, previousId } = (await request.json()) as {
    headline: string;
    previousId: string;
  };
  await client
    .transaction()
    .create({ _type: "announcement", headline, pinned: true })
    .patch(`drafts.${previousId}`, { unset: ["pinned"] })
    .createOrReplace({ _id: `drafts.notice-latest`, _type: "announcement", headline })
    .commit();
  return Response.json({ ok: true });
}
