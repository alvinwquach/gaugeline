import { client } from "@/lib/client";
import { REVIEWS_QUERY } from "@/lib/queries";

export async function Reviews() {
  const reviews = await client.fetch(REVIEWS_QUERY);
  return (
    <section>
      {reviews.map(({ quote, author }) => (
        <blockquote key={quote}>
          {quote} <cite>{author}</cite>
        </blockquote>
      ))}
    </section>
  );
}
