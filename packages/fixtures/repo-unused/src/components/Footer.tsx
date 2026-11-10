import { sanityFetch } from "@/sanity/live";
import { SETTINGS_QUERY } from "@/lib/queries";

export async function Footer() {
  const { data } = await sanityFetch({ query: SETTINGS_QUERY });
  return (
    <footer>
      <p>{data.phone}</p>
      <p>{data.address}</p>
      <ul>
        {data.openingHours.map((hours) => (
          <li key={hours.day}>
            {hours.day}: {hours.opens} to {hours.closes}
          </li>
        ))}
      </ul>
    </footer>
  );
}
