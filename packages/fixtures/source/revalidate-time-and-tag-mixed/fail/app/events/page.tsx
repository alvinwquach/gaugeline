import { upcomingEvents } from "../../lib/events";

export default async function Events() {
  const events = await upcomingEvents();
  return (
    <ul>
      {events.map((e) => (
        <li key={e._id}>{e.title}</li>
      ))}
    </ul>
  );
}
