import groq from "groq";

export const eventsQuery = groq`*[_type == "popup" && venue->slug.current == $venue && date > $after]{
  title,
  date,
  "where": venue->{ name, "city": address.city }
}`;
