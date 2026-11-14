import { client } from "../../lib/sanity/client";

export default async function Events() {
  const events = await client.fetch<{ _id: string; title: string }[]>(
    '*[_type == "event"] | order(date asc)',
    {},
    { next: { tags: ["event"] } },
  );
  return (
    <ul>
      {events.map((e) => (
        <li key={e._id}>{e.title}</li>
      ))}
    </ul>
  );
}
