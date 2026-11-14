import { createClient } from "next-sanity";

export function sanityClient() {
  return createClient({
    projectId: process.env.SANITY_PROJECT_ID,
    dataset: "production",
    apiVersion: "2026-01-01",
    useCdn: false,
  });
}
