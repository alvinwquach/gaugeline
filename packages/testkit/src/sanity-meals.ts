import type { FakeSanity } from "./sanity-counts.js";

/**
 * Every text value in the invented Fennel & Rye dataset starts with this, so a test can search a
 * request log, an answer or an output for it and know a value from the content got out.
 */
export const MEALS_MARKER = "FENNEL-MARKER";

const meal = (id: string, calories: number) => ({
  _id: id,
  _type: "meal",
  name: `${MEALS_MARKER} ${id}`,
  calories,
});

const ref = (id: string, key: string) => ({ _type: "reference", _key: key, _ref: id });

const plan = (
  id: string,
  stated: number | string | undefined,
  days: string[][],
  extra: Record<string, unknown> = {},
) => ({
  _id: id,
  _type: "mealPlan",
  title: `${MEALS_MARKER} ${id}`,
  ...(stated === undefined ? {} : { targetCalories: stated }),
  days: days.map((meals, d) => ({
    _key: `day${d + 1}`,
    meals: meals.map((m, k) => ref(m, `d${d + 1}m${k + 1}`)),
  })),
  ...extra,
});

/**
 * Fennel & Rye Meal Prep's invented dataset for `gaugeline query --totals` and `--refs`: a weekly
 * meal-plan service whose plans are written by a script. Six published meals (and one that exists
 * only as a draft), and five published plans:
 *
 * - `plan-lean-week`: states 2400 calories; its meals add up to 1830, because two of its meals were
 *   never published (`meal-tofu-bowl` does not exist, `meal-miso-ramen` exists only as a draft).
 * - `plan-steady-week`: states 1980 and adds up to 1980; every meal is published.
 * - `plan-heavy-week`: states 2000; its meals, all published, add up to 1650.
 * - `plan-open-week`: states nothing (no target); its meals are published.
 * - `plan-gap-week`: states 1050 and adds up to 1050, but links to a meal that does not exist.
 *
 * `drafts.plan-lean-week` and `drafts.plan-draft-week` are drafts with mistakes that a published
 * query must never see. Every text value carries MEALS_MARKER. Nothing here was recorded from a
 * real dataset.
 */
export function mealsContent(): Record<string, Record<string, unknown>[]> {
  return {
    meal: [
      meal("meal-oat-bowl", 450),
      meal("meal-lentil-soup", 600),
      meal("meal-chicken-rice", 780),
      meal("meal-salmon-greens", 540),
      meal("meal-veg-curry", 660),
      meal("meal-herbal-tea", 0),
      // Exists only as a draft: it does not count as published.
      { ...meal("drafts.meal-miso-ramen", 500) },
    ],
    mealPlan: [
      plan("plan-lean-week", 2400, [
        ["meal-oat-bowl", "meal-lentil-soup"],
        ["meal-chicken-rice", "meal-tofu-bowl", "meal-miso-ramen"],
      ]),
      plan("plan-steady-week", 1980, [
        ["meal-veg-curry", "meal-salmon-greens", "meal-chicken-rice"],
      ]),
      plan("plan-heavy-week", 2000, [["meal-salmon-greens", "meal-veg-curry", "meal-oat-bowl"]]),
      plan("plan-open-week", undefined, [["meal-oat-bowl", "meal-herbal-tea"]]),
      plan("plan-gap-week", 1050, [["meal-oat-bowl", "meal-lentil-soup", "meal-tofu-bowl"]]),
      plan("drafts.plan-lean-week", 9999, [["meal-oat-bowl"]]),
      plan("drafts.plan-draft-week", 1, [["meal-gone"]]),
    ],
  };
}

export const FENNEL_MEALS: FakeSanity = { types: {}, content: mealsContent() };
