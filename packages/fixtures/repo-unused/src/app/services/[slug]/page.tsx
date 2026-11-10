import { PortableText } from "@portabletext/react";
import { client } from "@/lib/client";
import { SERVICE_QUERY } from "@/lib/queries";

const getService = (slug: string) => client.fetch(SERVICE_QUERY, { slug });

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const service = await getService((await params).slug);
  return { title: service.seoTitle };
}

export default async function ServicePage({ params }: { params: Promise<{ slug: string }> }) {
  const service = await getService((await params).slug);
  return (
    <article>
      <img src={service.heroUrl} alt="" />
      <h1>{service.title}</h1>
      <PortableText value={service.body} />
      <p>
        With {service.practitioner.name}
        <img src={service.practitioner.photo} alt="" />
      </p>
    </article>
  );
}
