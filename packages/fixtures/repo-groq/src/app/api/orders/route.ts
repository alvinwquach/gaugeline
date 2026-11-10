import groq from "groq";

// An order lookup by the address on the order. Only the fields the confirmation page shows.
const ordersByEmail = groq`*[_type == "order" && email == $email && !(_id in path("drafts.**"))]{
  _id,
  total,
  "items": lines[].item->name
}`;

export async function GET(): Promise<Response> {
  return Response.json({ query: ordersByEmail });
}
