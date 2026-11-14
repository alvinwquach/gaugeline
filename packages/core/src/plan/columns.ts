/** The plan reader's building blocks: column names and an RFC 4180 CSV parser. */
export type PlanField =
  "url" | "page" | "titleTag" | "h1" | "primaryKeyword" | "secondaryKeyword" | "legacyUrl";

/**
 * Normalised header -> field. A header either maps or it doesn't: "URL notes" is not the URL.
 * The docs list these names; a test reads every one.
 */
export const COLUMN_ALIASES: Readonly<Record<string, PlanField>> = Object.freeze({
  url: "url",
  address: "url",
  "new url": "url",
  destination: "url",
  "new address": "url",
  "page url": "url",
  page: "page",
  "page name": "page",
  "title tag": "titleTag",
  title: "titleTag",
  "meta title": "titleTag",
  h1: "h1",
  heading: "h1",
  "primary keyword": "primaryKeyword",
  keyword: "primaryKeyword",
  "target keyword": "primaryKeyword",
  "secondary keyword": "secondaryKeyword",
  "secondary keywords": "secondaryKeyword",
  "legacy url": "legacyUrl",
  "old url": "legacyUrl",
  "current url": "legacyUrl",
  "redirect from": "legacyUrl",
});

/** "Title_Tag", " TITLE-TAG " and "title tag" are one header. */
export function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * RFC 4180: fields separated by commas, records by CRLF or LF; a field in double quotes may hold
 * commas, line breaks and doubled quotes. Returns each record with the line it starts on.
 */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = 0;
  const endRecord = () => {
    cells.push(cell);
    records.push({ line: start, cells });
    cells = [];
    cell = "";
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (c === "\n") line++;
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      i++;
    } else if (c === ",") {
      cells.push(cell);
      cell = "";
      i++;
    } else if (c === "\r" && text[i + 1] === "\n") {
      endRecord();
      i += 2;
      line++;
      start = line;
    } else if (c === "\n" || c === "\r") {
      endRecord();
      i++;
      line++;
      start = line;
    } else {
      cell += c;
      i++;
    }
  }
  if (cell !== "" || cells.length > 0) endRecord();
  return records;
}
