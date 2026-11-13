import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://harbourbar.example/", lastModified: new Date("2026-11-01") }];
}
