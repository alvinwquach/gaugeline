import "server-only";
import { createClient } from "next-sanity";

// Read when the draft menu is asked for, never at import.
export function draftClient() {
  const token = process.env.SANITY_API_READ_TOKEN;
  return createClient({
    projectId: "quayside",
    dataset: "production",
    apiVersion: "2026-01-01",
    useCdn: false,
    token,
  });
}
