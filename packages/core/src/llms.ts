import { addressParts, type BusinessFacts } from "./facts/business.js";
import { normalisePhone, parseHoursText } from "./facts/normalise.js";

/** One entry in an llms.txt link section: "- [Title](url): notes". */
export interface LlmsLink {
  title: string;
  url: string;
  notes?: string;
  section: string;
}

/** An llms.txt file, as proposed at llmstxt.org: an H1, a blockquote summary, H2 link sections. */
export interface LlmsFile {
  title?: string;
  summary?: string;
  sections: { heading: string; links: LlmsLink[] }[];
  text: string;
}

const LINK = /^\s*[-*+]\s*\[([^\]]+)\]\(\s*<?([^)\s>]+)>?\s*\)\s*(?::\s*(.*))?$/;

export function parseLlmsTxt(raw: string): LlmsFile {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const file: LlmsFile = { sections: [], text };
  const summary: string[] = [];
  let current: LlmsFile["sections"][number] | undefined;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 && file.title === undefined && !current) {
      file.title = h1[1];
    } else if (h2) {
      current = { heading: h2[1] ?? "", links: [] };
      file.sections.push(current);
    } else if (!current && /^>\s?/.test(line)) {
      summary.push(line.replace(/^>\s?/, "").trim());
    } else if (current) {
      const m = LINK.exec(line);
      if (m) {
        current.links.push({
          title: (m[1] ?? "").trim(),
          url: m[2] ?? "",
          ...(m[3] && m[3].trim() !== "" ? { notes: m[3].trim() } : {}),
          section: current.heading,
        });
      }
    }
  }
  if (summary.length > 0) file.summary = summary.join(" ").trim();
  return file;
}

const PHONE_LABEL = /\b(?:phone|tel|telephone|call(?: us)?)\b/i;
const PHONE = /\+?\(?\d[\d\s().-]{5,}\d/g;
const ADDRESS_LABEL =
  /^\s*(?:[-*+]\s*)?(?:\*\*)?(?:address|location|find us)(?:\*\*)?\s*[:—–-]\s*(.+)$/i;

/**
 * Facts written in an llms.txt: phone numbers on lines labelled phone, tel or call (and tel:
 * links), opening hours wherever "days times" is written, and an "Address:" line. Only labelled
 * numbers count, so a date or an order number is never read as a phone number.
 */
export function llmsFacts(
  file: LlmsFile,
): BusinessFacts & { phones: { text: string; digits: string }[] } {
  const phones: { text: string; digits: string }[] = [];
  const add = (t: string) => {
    const digits = normalisePhone(t);
    if (digits && !phones.some((p) => p.digits === digits)) phones.push({ text: t.trim(), digits });
  };
  let address: string | undefined;
  for (const line of file.text.split("\n")) {
    for (const m of line.matchAll(/\(tel:([^)\s]+)\)/gi)) add(m[1] ?? "");
    if (PHONE_LABEL.test(line)) {
      for (const m of line.replace(/\(tel:[^)]*\)/gi, "").matchAll(PHONE)) {
        // Times such as 09:00-17:00 contain no colon-free run of 7 digits, but guard anyway.
        if (!m[0].includes(":")) add(m[0]);
      }
    }
    const a = ADDRESS_LABEL.exec(line);
    if (a && address === undefined) address = (a[1] ?? "").replace(/\*\*/g, "").trim();
  }
  const facts: BusinessFacts & { phones: typeof phones } = {
    phones,
    hours: parseHoursText(file.text),
  };
  if (file.title) facts.name = file.title;
  if (address) {
    facts.addressText = address;
    Object.assign(facts, addressParts(address));
  }
  return facts;
}
