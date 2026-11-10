import { defineQuery, groq } from "next-sanity";

export const SERVICES_QUERY = groq`
  *[_type == "service"] | order(title) {
    _id,
    title,
    "slug": slug.current,
    summary,
    price
  }
`;

export const SERVICE_QUERY = defineQuery(`
  *[_type == "service" && slug.current == $slug][0] {
    title,
    seoTitle,
    body,
    "heroUrl": hero.asset->url,
    practitioner->{ name, bio, photo }
  }
`);

export const SETTINGS_QUERY = defineQuery(`
  *[_type == "settings"][0] {
    phone,
    address,
    openingHours[]{ day, opens, closes },
    instagram
  }
`);

export const TEAM_QUERY = groq`
  *[_type == "practitioner"] | order(name) {
    name,
    role,
    "photo": photo.asset->url,
    qualifications
  }
`;

export const REVIEWS_QUERY = groq`
  *[_type == "review"][0...6] { _id, quote, author }
`;

export const SEARCH_INDEX_QUERY = groq`
  *[_type in ["service", "practitioner"]] { title, name, "slug": slug.current }
`;
