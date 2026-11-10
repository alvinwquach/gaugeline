import { defineQuery } from "next-sanity";

export function upcoming(dateFilter: string): string {
  return defineQuery('*[_type == "popup"' + dateFilter + "]{ title, date }");
}
