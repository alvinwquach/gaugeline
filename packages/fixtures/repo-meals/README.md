# repo-meals

An invented source tree for Fennel & Rye Meal Prep, a small weekly meal-plan business with a Next.js
site on Sanity. It is the folder `gaugeline query ./src --totals ... --refs ...` is pointed at in its
tests and in docs/query-check.md. Nothing here is a real business, and nothing in it is ever run:
the two flags ask the dataset and read no file, so this folder only has to exist.

The invented dataset the rules run against is `FENNEL_MEALS` in `packages/testkit/src/sanity-meals.ts`:
a script writes each week's `mealPlan` with a `targetCalories` and the days' meals as references.
