import { defineField, defineType } from "sanity";

export const page = defineType({
  name: "page",
  type: "document",
  fields: [
    defineField({
      name: "sections",
      type: "array",
      of: [{ type: "hero" }, { type: "menuGallery" }],
    }),
  ],
});
