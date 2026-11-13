import { createClient } from "next-sanity";

// Harbor Lane Taproom: the events and the menu are published in the studio and read here.
export const client = createClient({
  projectId: "harborlane",
  dataset: "production",
  apiVersion: "2026-01-01",
  useCdn: true,
});
