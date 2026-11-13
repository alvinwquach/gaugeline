import { groq } from "next-sanity";

export const NOTES = groq`*[_type == "post"] | order(_createdAt desc) {
  title,
  writer,
  "seasons": seasons
}`;
