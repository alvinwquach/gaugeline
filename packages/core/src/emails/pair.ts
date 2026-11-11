import { ISO_639_1 } from "../languages.js";

/** order.es.html -> base "order", language "es"; es-MX and es_MX are "es-mx". No language suffix: none. */
export interface NamedEmail {
  /** The path without the language suffix and the extension, with "/" separators. */
  base: string;
  lang?: string;
  file: string;
}

const SUFFIX = /^(.*)\.([A-Za-z]{2})(?:[-_]([A-Za-z]{2}|\d{3}|[A-Za-z]{4}))?$/;

/** The base name and language of an email's path ("emails/order.es.html"). */
export function nameEmail(file: string): NamedEmail {
  const stem = file.replace(/\.html?$/i, "");
  const m = SUFFIX.exec(stem);
  const primary = m?.[2]?.toLowerCase();
  if (!m || primary === undefined || !ISO_639_1.has(primary)) return { base: stem, file };
  const region = m[3]?.toLowerCase();
  return { base: m[1] ?? stem, lang: region ? `${primary}-${region}` : primary, file };
}

export interface EmailPairs {
  /** base -> language -> file. Only emails with a language suffix are in it. */
  groups: Map<string, Map<string, string>>;
  /** Every language any email in the folder is written in, sorted. */
  languages: string[];
}

/**
 * Pair emails by base name and language suffix. Two Maps and a Set, because the questions are "which
 * languages does this email exist in" and "which languages does the folder use", both lookups.
 */
export function pairEmails(files: readonly string[]): EmailPairs {
  const groups = new Map<string, Map<string, string>>();
  const languages = new Set<string>();
  for (const file of files) {
    const n = nameEmail(file);
    if (n.lang === undefined) continue;
    languages.add(n.lang);
    const group = groups.get(n.base) ?? new Map<string, string>();
    if (!group.has(n.lang)) group.set(n.lang, file);
    groups.set(n.base, group);
  }
  return { groups, languages: [...languages].sort() };
}
