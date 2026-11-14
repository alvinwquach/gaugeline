import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: "production",
  apiVersion: "2026-01-01",
  useCdn: true,
});

const moved = await client.fetch(`*[_type == "movedPage"]{ from, to }`);

/** @type {import("next").NextConfig} */
const nextConfig = {
  async redirects() {
    return moved.map((p) => ({ source: p.from, destination: p.to, permanent: true }));
  },
};

export default nextConfig;
