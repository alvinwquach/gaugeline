import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { badTelNumber } from "./mobile.js";

export const telFormat = defineCheck<PageSnapshot>({
  id: "tel-format",
  size: "S",
  done: "Each tel: link is digits with a leading + and country code.",
  estimateChanges: "Links typed into content are one edit each.",
  area: "Visitors",
  severity: "low",
  title: "A phone link may not dial correctly",
  what: "A tel: link has spaces or brackets in the number.",
  why: "Some phones and click-to-call tools dial the wrong number, or nothing, when the link has spaces or brackets.",
  fix: 'Write the link as digits with a leading + and country code, for example href="tel:+14155550100". Keep the spaced format in the visible text only.',
  tech: 'an a[href^="tel:"] contains a space, ( or ); "-" and "." pass. One finding per distinct number',
  run(page) {
    const seen = new Set<string>();
    return page.links.flatMap((l) => {
      const number = badTelNumber(l.href);
      if (number === undefined || seen.has(number)) return [];
      seen.add(number);
      return [
        {
          checkId: "tel-format",
          severity: "low" as const,
          title: this.title,
          evidence: `<a href="tel:${number}"> has ${/\s/.test(number) ? "spaces" : "brackets"}${/\s/.test(number) && /[()]/.test(number) ? " and brackets" : ""}`,
          url: page.finalUrl,
        },
      ];
    });
  },
});
