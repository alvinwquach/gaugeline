import { dnsName } from "../dns.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isDmarc } from "./email/records.js";

export const emailDmarcMissing = defineCheck<PageSnapshot>({
  id: "email-dmarc-missing",
  size: "S",
  done: "A TXT record at _dmarc names a policy and an address you read.",
  estimateChanges:
    "The address that receives reports has to exist and be watched, which is the ongoing cost.",
  area: "Security & email",
  severity: "medium",
  title: "Your domain has no DMARC policy",
  what: "There is no DMARC record at _dmarc.<your domain>, so receiving servers have no instruction for mail that fails SPF or DKIM.",
  why: "Mail pretending to be from you is delivered like any other, and large mail providers increasingly expect a DMARC record from anyone who sends.",
  fix: "Add a TXT record at _dmarc.<your domain>: start with v=DMARC1; p=none; rua=mailto:<an address you read>, then move to quarantine once the reports look right.",
  tech: "Public DNS only: no TXT record starting v=DMARC1 at _dmarc.<host without www.>. The host is read as given; a parent domain's policy is not looked up",
  async run(page, ctx) {
    const domain = dnsName(page.finalUrl);
    if (!ctx.dns || !domain || ctx.dns.skips?.(domain)) return [];
    if ((await ctx.dns.txt(`_dmarc.${domain}`)).some(isDmarc)) return [];
    return [
      {
        checkId: "email-dmarc-missing",
        severity: "medium",
        title: this.title,
        evidence: `no TXT record starting v=DMARC1 at _dmarc.${domain}`,
        url: page.finalUrl,
      },
    ];
  },
});
