import type { AppLookup } from "../apps.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

const STORE = { apple: "App Store", google: "Google Play" } as const;

function label(l: AppLookup): string {
  return `${STORE[l.ref.store]} app ${l.ref.id}`;
}

export const appLinkDead = defineCheck<PageSnapshot>({
  id: "app-link-dead",
  size: "S",
  done: "The link goes to the app's current store page, or is gone, and the store page loads.",
  estimateChanges: "The same link in the header, the footer and old posts is one edit each.",
  area: "Visitors",
  severity: "high",
  title: "The app this page links to isn't in the store",
  what: "An App Store or Google Play link on the page names an app the store no longer has.",
  why: 'Visitors who tap "Get the app" land on an error page. Apps disappear when they are renamed, moved to a new developer account or pulled.',
  fix: "Link to the app's current store page, or remove the link if the app is gone.",
  tech: "the iTunes Lookup API returns no result for the id (in the link's storefront and in the US), or the Google Play listing answers 404. A 429 or a regional-only app is could-not-check, not dead",
  async run(_page, ctx) {
    const lookups = await ctx.apps?.();
    if (!lookups || lookups.length === 0) return [];
    const unchecked = lookups.filter((l) => l.state === "unchecked");
    for (const l of unchecked) ctx.warn(`Could not check ${label(l)}: ${l.reason}`);
    if (unchecked.length === lookups.length) {
      // Nothing could be checked: report "could not run" with the reasons, never "dead".
      throw new Error(
        `No app could be checked: ${unchecked.map((l) => `${label(l)}: ${l.reason}`).join("; ")}`,
      );
    }
    return lookups.flatMap((l) =>
      l.state === "missing"
        ? [
            {
              checkId: "app-link-dead",
              severity: "high" as const,
              title: this.title,
              evidence: `${l.ref.href} names ${label(l)}, which ${STORE[l.ref.store]} does not have${l.ref.store === "google" ? " (404)" : ""}`,
              url: l.ref.href,
            },
          ]
        : [],
    );
  },
});
