import { businessFromJsonLd } from "../facts/business.js";
import { hoursDisagree } from "../facts/normalise.js";
import { llmsFacts } from "../llms.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

const DAY_LABEL = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export const llmsTxtStaleFacts = defineCheck<PageSnapshot>({
  id: "llms-txt-stale-facts",
  size: "S",
  done: "llms.txt gives the same phone number, address and hours as the structured data.",
  estimateChanges: "Generating both from one source removes the drift but needs a template change.",
  area: "Search & sharing",
  severity: "medium",
  title: "Your llms.txt gives assistants an old phone number, address or hours",
  what: "The phone number, street address or opening hours in /llms.txt disagree with the page's structured data.",
  why: "Assistants quote llms.txt directly. An old number or old hours there is what someone hears when they ask if you're open tonight.",
  fix: "Update llms.txt to match the structured data (or the other way round, whichever is wrong). Generate both from one source if you can.",
  tech: "hours, telephone or address in /llms.txt differ from the page's LocalBusiness JSON-LD",
  async run(page, ctx) {
    const site = await ctx.site?.();
    const file = site?.llms.file;
    const ld = businessFromJsonLd(page);
    if (!site || !file || !ld) return [];
    const llms = llmsFacts(file);
    const diffs: string[] = [];
    if (ld.phone && llms.phones.length > 0 && !llms.phones.some((p) => p.digits === ld.phone)) {
      diffs.push(
        `phone: llms.txt says ${llms.phones.map((p) => p.text).join(" or ")}, structured data says ${ld.phoneText ?? ld.phone}`,
      );
    }
    if (
      (ld.streetNumber && llms.streetNumber && ld.streetNumber !== llms.streetNumber) ||
      (ld.zip && llms.zip && ld.zip !== llms.zip)
    ) {
      diffs.push(
        `address: llms.txt says "${llms.addressText ?? ""}", structured data says "${ld.addressText ?? ""}"`,
      );
    }
    const hours = hoursDisagree(llms.hours, ld.hours);
    if (hours.length > 0) {
      diffs.push(
        `hours: ${hours.map((h) => `${DAY_LABEL[h.day]} ${h.a} in llms.txt, ${h.b} in structured data`).join("; ")}`,
      );
    }
    if (diffs.length === 0) return [];
    return [
      {
        checkId: "llms-txt-stale-facts",
        severity: "medium",
        title: this.title,
        evidence: diffs.join(". "),
        url: site.llms.url,
      },
    ];
  },
});
