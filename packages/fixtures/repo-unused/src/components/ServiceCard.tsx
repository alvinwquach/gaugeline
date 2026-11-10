import Link from "next/link";

export function ServiceCard({
  service,
}: {
  service: { title: string; slug: string; price: number };
}) {
  const { title, slug } = service;
  return (
    <Link href={`/services/${slug}`}>
      <h2>{title}</h2>
      <p>From {service.price} pounds</p>
    </Link>
  );
}
