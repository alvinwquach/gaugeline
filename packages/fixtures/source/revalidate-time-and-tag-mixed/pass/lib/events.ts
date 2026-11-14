import { client } from "./client";

// Blue Heron Pop-Up: the list of dates is published in the studio and cleared by tag.
export function upcomingEvents() {
  return client.fetch<{ _id: string; title: string }[]>(
    '*[_type == "event"] | order(date asc)',
    {},
    { next: { tags: ["event"] } },
  );
}
