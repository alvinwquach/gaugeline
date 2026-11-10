import { defineQuery } from "next-sanity";
import groq from "groq";

// Each of these is exported here and used by pages in other files.
export const menuQuery = groq`*[_type == "menuItem" && !(_id in path("drafts.**"))] | order(name asc) {
  _id,
  name,
  "slug": slug.current,
  price,
  category->{ title, "slug": slug.current }
}`;

export const settingsQuery = defineQuery(`*[_type == "siteSettings"][0]{
  title,
  "logo": logo.asset->url,
  contact{ phone, address{ street, city } }
}`);

export const popupQuery = defineQuery(
  '*[_type == "popup" && date >= now()] | order(date asc){ title, date, "venue": venue->name }',
);

export const journalQuery = groq`*[_type in ["post", "recipe"] && !(_id in path("drafts.**"))]{
  title,
  "slug": slug.current,
  publishedAt
}`;
