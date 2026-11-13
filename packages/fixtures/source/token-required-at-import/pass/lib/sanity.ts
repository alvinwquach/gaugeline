import { createClient } from "next-sanity";

// Read on the draft path only, so a build or a test that never asks for a draft needs no secret.
export function draftClient() {
  const token = process.env.SANITY_API_READ_TOKEN;
  if (!token) throw new Error("Draft preview needs SANITY_API_READ_TOKEN");
  return createClient({
    projectId: "quayside",
    dataset: "production",
    apiVersion: "2026-01-01",
    useCdn: false,
    token,
  });
}
