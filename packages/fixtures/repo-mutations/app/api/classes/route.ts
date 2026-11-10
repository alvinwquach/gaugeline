import { client } from "@/sanity/client";

// The booking form posts a new class. The instructor is picked from a list of ids.
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { title: string; instructorId: string };
  const created = await client.create({
    _type: "classSession",
    title: body.title,
    instructor: "instructor-ana",
  });
  return Response.json({ id: created._id });
}
