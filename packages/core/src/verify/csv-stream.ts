/**
 * An RFC 4180 CSV reader fed in chunks, so a 200,000-row export is never held whole: each push
 * returns the records it completed, with the line each starts on. Same rules as plan's parseCsv:
 * commas, CRLF or LF, double-quoted fields that may hold commas, line breaks and doubled quotes.
 */
export interface CsvRecord {
  line: number;
  cells: string[];
}

export interface CsvStream {
  push(chunk: string): CsvRecord[];
  /** The last record, if the text didn't end with a line break. */
  end(): CsvRecord[];
}

export function createCsvStream(): CsvStream {
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  /** A quote just closed: the next character decides (another quote is a literal one). */
  let closing = false;
  /** A CR was the last character of a chunk: an LF opening the next one belongs to it. */
  let pendingCr = false;
  let line = 1;
  let start = 1;
  let first = true;
  const out: CsvRecord[] = [];
  const endRecord = () => {
    cells.push(cell);
    out.push({ line: start, cells });
    cells = [];
    cell = "";
  };
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const c = text[i] as string;
      if (first) {
        first = false;
        if (c === "\uFEFF") continue;
      }
      if (pendingCr) {
        pendingCr = false;
        if (c === "\n") continue;
      }
      if (closing) {
        closing = false;
        if (c === '"') {
          cell += '"';
          quoted = true;
          continue;
        }
      }
      if (quoted) {
        if (c === '"') {
          quoted = false;
          closing = true;
          continue;
        }
        if (c === "\n") line++;
        cell += c;
        continue;
      }
      if (c === '"' && cell === "") {
        quoted = true;
      } else if (c === ",") {
        cells.push(cell);
        cell = "";
      } else if (c === "\r" || c === "\n") {
        endRecord();
        line++;
        start = line;
        if (c === "\r") {
          if (i + 1 < text.length) {
            if (text[i + 1] === "\n") i++;
          } else pendingCr = true;
        }
      } else {
        cell += c;
      }
    }
  };
  return {
    push(chunk) {
      feed(chunk);
      return out.splice(0);
    },
    end() {
      if (cell !== "" || cells.length > 0) endRecord();
      return out.splice(0);
    },
  };
}
