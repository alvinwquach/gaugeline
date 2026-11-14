import { createClient } from "next-sanity";

// The read token for the draft menu. Nothing here marks the file as server-only.
const token = process.env.SANITY_API_READ_TOKEN;

export const client = createClient({
  projectId: "quayside",
  dataset: "production",
  apiVersion: "2026-01-01",
  useCdn: false,
  token,
});
