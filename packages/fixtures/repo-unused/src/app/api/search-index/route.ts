import { client } from "@/lib/client";
import { SEARCH_INDEX_QUERY } from "@/lib/queries";

export async function GET() {
  const pages = await client.fetch(SEARCH_INDEX_QUERY);
  return new Response(JSON.stringify(pages), { headers: { "content-type": "application/json" } });
}
