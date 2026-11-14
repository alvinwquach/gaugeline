import { defineField, defineType } from "sanity";

export const dish = defineType({
  name: "dish",
  type: "document",
  fields: [
    defineField({ name: "name", type: "string" }),
    defineField({ name: "photo", type: "image", options: { hotspot: true } }),
  ],
});
