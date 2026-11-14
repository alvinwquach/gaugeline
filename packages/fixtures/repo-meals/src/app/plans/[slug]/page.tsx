import { defineQuery } from "next-sanity";

export const planQuery = defineQuery(`*[_type == "mealPlan" && slug.current == $slug][0]{
  title,
  targetCalories,
  days[]{ meals[]->{ name, calories } }
}`);
