import { ServiceCard } from "@/components/ServiceCard";
import { client } from "@/lib/client";
import { SERVICES_QUERY } from "@/lib/queries";

export default async function ServicesPage() {
  const services = await client.fetch(SERVICES_QUERY);
  return (
    <main>
      <h1>Treatments</h1>
      {services.map((service) => (
        <ServiceCard key={service.slug} service={service} />
      ))}
    </main>
  );
}
