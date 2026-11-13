import { stegaClean } from "next-sanity";
import { sanityFetch } from "../lib/live";

export default async function Page() {
  const { data } = await sanityFetch({ query: '*[_type == "page"][0]{ layout, bookingUrl }' });
  return (
    <main className={stegaClean(data.layout) === "wide" ? "wide" : "narrow"}>
      <a href={stegaClean(data.bookingUrl)}>Book a table</a>
    </main>
  );
}
