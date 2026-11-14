import groq from "groq";

// The old About page, still served for the bakery's Spanish-language flyer.
export const legacyQuery = groq`*[_type == "legacyPage"]{ title, body }`;
