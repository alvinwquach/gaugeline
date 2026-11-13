import { defineField, defineType } from "sanity";

export const post = defineType({
  name: "post",
  title: "Menu note",
  type: "document",
  fields: [
    defineField({ name: "title", type: "string" }),
    defineField({ name: "writer", type: "reference", to: [{ type: "person" }] }),
    defineField({
      name: "seasons",
      type: "array",
      of: [{ type: "reference", to: [{ type: "season" }] }],
    }),
  ],
});
