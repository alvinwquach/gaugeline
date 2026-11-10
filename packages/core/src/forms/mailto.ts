import type { PageSnapshot } from "../snapshot.js";

/** A link that opens an email from a call to action: its words, and the address it writes to. */
export type MailtoCta = { text: string; address: string };

/**
 * The words of a contact button: "Contact us", "Talk to an expert", "Get a quote", "Email us". A link
 * whose text is an address (an email address written out) is a published contact, not a button, and a link
 * with other words ("Opening hours") is not a call to action. English only; the snapshot has no
 * class or role, so a link styled as a button cannot be told from a text link.
 */
const CTA_WORDS =
  /\b(?:contact|talk|speak|chat|get in touch|reach out|e-?mail us|message us|write to us|send us|enquir\w*|inquir\w*|book|quote|demo|consult\w*|schedule|request|apply|hire|expert|sales|sign up|get started)\b/i;

/** The address a mailto: link writes to, without its query (subject, body), or undefined when it has none. */
function mailtoAddress(href: string): string | undefined {
  if (!/^mailto:/i.test(href)) return undefined;
  const rest = href.slice("mailto:".length).split("?")[0] ?? "";
  let address: string;
  try {
    address = decodeURIComponent(rest);
  } catch {
    address = rest;
  }
  address = address.trim();
  return address.includes("@") ? address : undefined;
}

/**
 * The page's contact buttons that open one person's email instead of a form. Reads the links in the
 * snapshot only. The same words and address twice are one result.
 */
export function findMailtoCtas(s: PageSnapshot): MailtoCta[] {
  const seen = new Set<string>();
  const out: MailtoCta[] = [];
  for (const link of s.links) {
    const address = mailtoAddress(link.href);
    if (address === undefined) continue;
    const text = link.text.replace(/\s+/g, " ").trim();
    if (text === "" || text.includes("@") || !CTA_WORDS.test(text)) continue;
    const key = `${text.toLowerCase()}\n${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, address });
  }
  return out;
}
