import { createClient } from "next-sanity";

export const client = createClient({
  projectId: "blueheron",
  dataset: "production",
  apiVersion: "2026-01-01",
  useCdn: false,
});
