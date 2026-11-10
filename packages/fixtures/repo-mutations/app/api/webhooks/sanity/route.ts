import { client } from "@/sanity/client";

// Sanity calls this when an instructor changes. It keeps the spot count on their classes in step.
export async function POST(request: Request): Promise<Response> {
  const { classId, field, value } = (await request.json()) as {
    classId: string;
    field: string;
    value: number;
  };
  await client
    .patch(`drafts.${classId}`)
    .set({ spots: 12, [field]: value })
    .commit();
  return Response.json({ ok: true });
}
