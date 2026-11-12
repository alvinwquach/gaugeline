import { defineCheck } from "../model.js";
import { claim, settingsIssues } from "../images/shared.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

export const imageOptimizerAllowlistUnanchored = defineCheck<PageSnapshot>({
  id: "image-optimizer-allowlist-unanchored",
  size: "S",
  done: "Every remote_images expression in netlify.toml starts with a caret and ends with a dollar sign.",
  estimateChanges: "One line per expression in netlify.toml.",
  area: "Security & email",
  severity: "medium",
  title: "An image allowlist expression is not anchored",
  what: "A Netlify remote_images expression in the settings you gave does not start with ^ and end with $, so it matches when the allowed address appears anywhere in the image address.",
  why: "An address such as https://evil.example/?x=https://images.yourshop.example/ then passes the allowlist, and the Image CDN fetches it for anyone who asks.",
  fix: "Anchor each expression and escape its dots: ^https://images\\\\.yourshop\\\\.example/.*$.",
  tech: "Not a probing check: no request is made. Reads settingsFiles of gaugeline.images.json as text and reports each remote_images entry that lacks a leading ^ or a trailing $ (an entry that matches every address is image-optimizer-allowlist-wide). A statement about the file, not about the running site",
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const cfg = ctx.imageSettings;
    if (!cfg || cfg.settings.length === 0 || !claim(cfg, this.id)) return [];
    const origin = new URL(page.finalUrl).origin;
    return settingsIssues(cfg)
      .filter((i) => i.kind === "unanchored")
      .map((i) => ({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${i.file} line ${i.line}: ${i.entry} is not anchored with ^ and $`,
        url: `${origin}/`,
      }));
  },
});
