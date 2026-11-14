import groq from "groq";

const homeQuery = groq`*[_type == "page" && slug.current == "home"][0]{
  title,
  sections[]{ _type, heading, "image": image.asset->url }
}`;

export default function Home() {
  return <main data-query={homeQuery}>Copperhill Bakery</main>;
}
