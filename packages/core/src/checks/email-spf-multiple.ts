import { dnsName } from "../dns.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isSpf, receivesMail } from "./email/records.js";

export const emailSpfMultiple = defineCheck<PageSnapshot>({
  id: "email-spf-multiple",
  area: "Security & email",
  severity: "medium",
  title: "Your domain has two SPF records, which cancels both",
  what: "Two or more TXT records at the domain start with v=spf1.",
  why: "Receiving mail servers treat more than one SPF record as an error and ignore all of them, so your mail is checked as if you had none.",
  fix: "Merge them into one record: one v=spf1, every include from both, one -all or ~all at the end.",
  tech: "Public DNS only: the domain has MX records (not a null MX) and two or more TXT records start with v=spf1 (RFC 7208 §4.5: a permerror)",
  async run(page, ctx) {
    const domain = dnsName(page.finalUrl);
    if (!ctx.dns || !domain || ctx.dns.skips?.(domain)) return [];
    if (!receivesMail(await ctx.dns.mx(domain))) return [];
    const spf = (await ctx.dns.txt(domain)).filter(isSpf);
    if (spf.length < 2) return [];
    return [
      {
        checkId: "email-spf-multiple",
        severity: "medium",
        title: this.title,
        evidence: `${domain} has ${spf.length} SPF records: ${spf.map((r) => `"${r}"`).join("; ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
