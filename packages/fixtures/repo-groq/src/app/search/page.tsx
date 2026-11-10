import groq from "groq";

export function searchQuery(term: string): string {
  // The query changes with what the visitor typed, so it cannot be read from the file.
  return groq`*[_type == "menuItem" && name match ${term}]{ name }`;
}
