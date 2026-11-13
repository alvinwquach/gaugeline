/**
 * Invented findings for the triage agent's tests (AG-12): a bakery pop-up and a physiotherapy clinic site, no
 * real client, venue, address or person. Every address is on a reserved .example domain.
 */
import type { TriageFinding } from "../plan.js";

export const finding = (
  id: string,
  checkId: string,
  severity: TriageFinding["severity"] = "medium",
  over: Partial<TriageFinding> = {},
): TriageFinding => ({
  id,
  checkId,
  severity,
  title: `Title of ${id}`,
  evidence: `Evidence of ${id}`,
  url: `https://crumb-and-co.example/${id}`,
  ...over,
});

/** Two pages with no canonical link, one image without alt text, a certificate about to expire. */
export const bakery: TriageFinding[] = [
  finding("f-101", "canonical-missing", "medium", {
    title: "Menu page has no canonical link",
    evidence: "",
    url: "https://crumb-and-co.example/menu",
  }),
  finding("f-102", "canonical-missing", "medium", {
    title: "Pop-up page has no canonical link",
    evidence: "",
    url: "https://crumb-and-co.example/pop-up",
  }),
  finding("f-103", "images-alt-missing", "medium", {
    title: "Hero image has no alt text",
    evidence: "3 images have no alt attribute",
    url: "https://crumb-and-co.example/",
  }),
  finding("f-104", "certificate-expiring", "high", {
    title: "Certificate expires in 9 days",
    evidence: "valid until 2026-11-22",
    url: "https://crumb-and-co.example/",
  }),
  finding("f-105", "links-vague-text", "low", {
    title: "A link says click here",
    evidence: "",
    url: "https://crumb-and-co.example/menu",
  }),
];
