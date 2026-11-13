import { createClient } from "next-sanity";

const token = process.env.SANITY_API_READ_TOKEN;

if (!token) {
  throw new Error("Missing SANITY_API_READ_TOKEN");
}

export const draftClient = createClient({
  projectId: "quayside",
  dataset: "production",
  apiVersion: "2026-01-01",
  useCdn: false,
  token,
});
