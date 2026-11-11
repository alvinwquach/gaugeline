import { dnsName } from "../dns.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isSpf, receivesMail } from "./email/records.js";
import { firstFew } from "./site-helpers.js";

export const emailSpfMissing = defineCheck<PageSnapshot>({
  id: "email-spf-missing",
  size: "S",
  done: "One TXT record starting v=spf1 lists every service that sends the domain's email.",
  estimateChanges:
    "Each sending service (newsletter tool, shop, booking system) has to be found and listed. Slow DNS changes add waiting, not work.",
  area: "Security & email",
  severity: "high",
  title: "Your domain doesn't say who may send its email",
  what: "The domain receives email but publishes no SPF record listing the services allowed to send mail as it.",
  why: "Mail you send (receipts, booking confirmations) is more likely to land in spam, and anyone can send mail that claims to be from you.",
  fix: "Add one TXT record at the domain starting v=spf1 that includes each service that sends your mail (your email host, your newsletter tool), ending -all or ~all.",
  tech: "Public DNS only (node:dns/promises, TXT and MX): MX records exist and are not a null MX, and no TXT record at the host (without www.) starts with v=spf1. No mail server is contacted",
  async run(page, ctx) {
    const domain = dnsName(page.finalUrl);
    if (!ctx.dns || !domain || ctx.dns.skips?.(domain)) return [];
    const mx = await ctx.dns.mx(domain);
    if (!receivesMail(mx)) return [];
    if ((await ctx.dns.txt(domain)).some(isSpf)) return [];
    const hosts = [...mx].sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
    return [
      {
        checkId: "email-spf-missing",
        severity: "high",
        title: this.title,
        evidence: `${domain} receives email (MX ${firstFew(hosts)}) and has no TXT record starting v=spf1`,
        url: page.finalUrl,
      },
    ];
  },
});
