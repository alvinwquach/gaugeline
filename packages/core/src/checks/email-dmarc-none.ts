import { dnsName } from "../dns.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { dmarcTags, isDmarc } from "./email/records.js";

export const emailDmarcNone = defineCheck<PageSnapshot>({
  id: "email-dmarc-none",
  size: "M",
  done: "The DMARC policy moves from none to quarantine, then reject, after the reports look clean.",
  estimateChanges: "The weeks spent reading reports and fixing each sender that fails.",
  area: "Security & email",
  severity: "low",
  title: "Your DMARC policy only watches",
  what: "The domain's DMARC record has p=none: receiving servers report mail that fails, and deliver it anyway.",
  why: "That is the right first step, and it doesn't stop anyone sending mail as you. Left at none, it never will.",
  fix: "Read the DMARC reports for a few weeks, fix any service of yours that fails, then change p=none to p=quarantine (and later p=reject).",
  tech: "Public DNS only: the TXT record at _dmarc.<host> starting v=DMARC1 has p=none; sp (the subdomain policy) does not change this",
  async run(page, ctx) {
    const domain = dnsName(page.finalUrl);
    if (!ctx.dns || !domain || ctx.dns.skips?.(domain)) return [];
    const record = (await ctx.dns.txt(`_dmarc.${domain}`)).find(isDmarc);
    if (!record || dmarcTags(record).get("p") !== "none") return [];
    return [
      {
        checkId: "email-dmarc-none",
        severity: "low",
        title: this.title,
        evidence: `_dmarc.${domain}: "${record}"`,
        url: page.finalUrl,
      },
    ];
  },
});
