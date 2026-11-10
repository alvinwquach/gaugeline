import { defineQuery } from "next-sanity";

export const itemQuery = defineQuery(`*[_type == "menuItem" && slug.current == $slug][0]{
  name,
  description,
  allergens[]->{ name },
  "photo": photo.asset->url
}`);
