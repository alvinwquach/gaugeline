import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { sameName } from "./quotable-facts-disagree.js";

export const appNameMismatch = defineCheck<PageSnapshot>({
  id: "app-name-mismatch",
  area: "Visitors",
  severity: "low",
  title: "The store lists the app under a different name",
  what: "The name the App Store or Google Play shows for a linked app differs from the name you expect.",
  why: "A renamed or replaced app can mean the link points at an old listing, or at someone else's app.",
  fix: "Check the link points at the right listing. If the app was renamed on purpose, update the expected name.",
  tech: 'the store\'s app name differs from the expected app name (case, punctuation and a leading "The" ignored); only runs when an expected name is set',
  async run(_page, ctx) {
    const expected = ctx.expect?.appName;
    if (!expected) return [];
    const lookups = (await ctx.apps?.()) ?? [];
    return lookups.flatMap((l) =>
      l.state === "found" && !sameName(l.name, expected)
        ? [
            {
              checkId: "app-name-mismatch",
              severity: "low" as const,
              title: this.title,
              evidence: `${l.ref.store === "apple" ? "App Store" : "Google Play"} app ${l.ref.id} is "${l.name}"; expected "${expected}"`,
              url: l.ref.href,
            },
          ]
        : [],
    );
  },
});
