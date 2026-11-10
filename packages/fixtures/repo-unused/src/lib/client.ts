import { createClient } from "next-sanity";

export const client = createClient({
  projectId: "marlowphysio",
  dataset: "production",
  apiVersion: "2026-01-01",
  useCdn: true,
});
