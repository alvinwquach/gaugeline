import { client } from "@/sanity/client";

// Every morning, reopen the classes that were left without a status.
export async function GET(): Promise<Response> {
  const ids = await client.fetch<string[]>('*[_type == "classSession" && !defined(status)]._id');
  for (const id of ids) {
    await client.patch(`drafts.${id}`).setIfMissing({ status: "open" }).commit();
  }
  return Response.json({ reopened: ids.length });
}
