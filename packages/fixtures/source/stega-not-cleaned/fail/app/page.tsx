import { sanityFetch } from "../lib/live";

export default async function Page() {
  const { data } = await sanityFetch({ query: '*[_type == "page"][0]{ layout, bookingUrl }' });
  return (
    <main className={data.layout === "wide" ? "wide" : "narrow"}>
      <a href={data.bookingUrl}>Book a table</a>
    </main>
  );
}
