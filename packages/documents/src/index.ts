import { constants, inflateSync } from "node:zlib";

/**
 * The text layer of a PDF, read with node:zlib and nothing else. It reads what a menu or price list
 * made by a word processor, a design tool or a browser carries: page tree, content streams (Flate or
 * none), simple fonts and Type0 fonts with a ToUnicode map. Anything else is reported as unreadable
 * with the reason; nothing is guessed and nothing is OCRed.
 *
 * A hostile file is bounded: one linear pass over the bytes, a cap on objects, pages, the size of
 * one inflated stream and of all of them. Names from the file are only ever Map keys, never object
 * keys, so a font named "__proto__" is an ordinary name.
 */

export interface ReadLimits {
  /** Pages read; more are counted, not read. Default 200. */
  maxPages?: number;
  /** Inflated size of one stream. Default 4 MiB. */
  maxStreamBytes?: number;
  /** Inflated size of every stream read together. Default 48 MiB. */
  maxInflatedBytes?: number;
  /** Objects scanned. Default 50,000. */
  maxObjects?: number;
}

export type UnreadableReason =
  | "not-a-pdf"
  | "truncated"
  | "encrypted"
  | "no-text-layer"
  | "undecodable-fonts"
  | "unsupported-streams"
  | "too-complex";

export type PdfRead =
  | {
      ok: true;
      /** One string per page read, lines separated by "\n"; two spaces mark a wide gap on a line. */
      pages: string[];
      /** Pages found (at most maxPages + 1 when the file has more). */
      pageCount: number;
      /** The file has more pages than were read. */
      truncated: boolean;
    }
  | { ok: false; reason: UnreadableReason; message: string };

const DEFAULTS = {
  maxPages: 200,
  maxStreamBytes: 4 * 1024 * 1024,
  maxInflatedBytes: 48 * 1024 * 1024,
  maxObjects: 50_000,
};

const MESSAGES: Record<UnreadableReason, string> = {
  "not-a-pdf": "the file is not a PDF",
  truncated: "the file ends early (no end-of-file marker), so it was not read",
  encrypted: "the PDF is encrypted",
  "no-text-layer": "the PDF has no text layer (a scan or a picture of a page); it is never OCRed",
  "undecodable-fonts": "the PDF's fonts do not say which letters their characters are",
  "unsupported-streams": "the PDF stores its pages in a form this reader does not decode",
  "too-complex": "the PDF is larger or more tangled than this reader will open",
};

const fail = (reason: UnreadableReason): PdfRead => ({
  ok: false,
  reason,
  message: MESSAGES[reason],
});

interface Obj {
  dict: string;
  data?: Uint8Array;
}

class Overrun extends Error {}

/** The value after /Key in a dictionary's text, or undefined. Keys are constants, never from the file. */
function after(dict: string, key: string): number | undefined {
  const m = new RegExp(`/${key}(?![A-Za-z0-9_.-])\\s*`).exec(dict);
  return m ? m.index + m[0].length : undefined;
}

/** "<<...>>" or "[...]" starting at i, to its matching close; literal strings are skipped. */
function balanced(text: string, i: number): string | undefined {
  const open = text[i];
  if (open !== "<" && open !== "[") return undefined;
  let depth = 0;
  for (let p = i; p < text.length && p < i + 200_000; p++) {
    const c = text[p];
    if (c === "(") {
      p = skipString(text, p);
      continue;
    }
    if (c === "<" && text[p + 1] === "<") {
      depth++;
      p++;
    } else if (c === ">" && text[p + 1] === ">") {
      depth--;
      p++;
      if (depth === 0 && open === "<") return text.slice(i, p + 1);
    } else if (open === "[" && c === "[") depth++;
    else if (open === "[" && c === "]") {
      depth--;
      if (depth === 0) return text.slice(i, p + 1);
    }
  }
  return undefined;
}

/** Index of the ")" that closes the literal string opening at i. */
function skipString(text: string, i: number): number {
  let depth = 0;
  for (let p = i; p < text.length; p++) {
    const c = text[p];
    if (c === "\\") p++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return p;
  }
  return text.length;
}

const REF = /^\s*(\d+)\s+\d+\s+R\b/;

/** The text of a value: an inline <<...>> or [...], or the dictionary of the object it points to. */
function valueOf(objs: ReadonlyMap<number, Obj>, dict: string, key: string): string | undefined {
  const at = after(dict, key);
  if (at === undefined) return undefined;
  const ref = REF.exec(dict.slice(at, at + 40));
  if (ref) return objs.get(Number(ref[1]))?.dict;
  return balanced(dict, at) ?? dict.slice(at, at + 80);
}

function refsIn(text: string): number[] {
  return [...text.matchAll(/(\d+)\s+\d+\s+R\b/g)].map((m) => Number(m[1]));
}

const FLATE = /\/(?:FlateDecode|Fl)\b/;

function decode(
  obj: Obj,
  limits: Required<ReadLimits>,
  budget: { used: number },
): Uint8Array | "unsupported" {
  const data = obj.data ?? new Uint8Array(0);
  const at = after(obj.dict, "Filter");
  if (at === undefined) return data;
  const list = obj.dict[at] === "[" ? (balanced(obj.dict, at) ?? "") : obj.dict.slice(at, at + 40);
  const names = [...list.matchAll(/\/[A-Za-z0-9]+/g)].map((m) => m[0]);
  const named = obj.dict[at] === "[" ? names : names.slice(0, 1);
  // One Flate filter is decoded; a list with a second filter (ASCII85, LZW, DCT) is not.
  if (named.length !== 1 || !FLATE.test(`${named[0]} `)) return "unsupported";
  try {
    const out = inflateSync(data, {
      maxOutputLength: limits.maxStreamBytes,
      finishFlush: constants.Z_SYNC_FLUSH,
    });
    budget.used += out.length;
    if (budget.used > limits.maxInflatedBytes) throw new Overrun();
    return out;
  } catch (err) {
    if (err instanceof Overrun) throw err;
    if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new Overrun();
    return "unsupported";
  }
}

// ---- ToUnicode maps -----------------------------------------------------------------------------

/** Lone surrogates become U+FFFD, so the text is safe to encode anywhere. */
function wellFormed(text: string): string {
  return text.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "\ufffd",
  );
}

function hexToText(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 4) {
    const unit = parseInt(clean.slice(i, i + 4).padEnd(4, "0"), 16);
    if (!Number.isNaN(unit)) out += String.fromCharCode(unit);
  }
  return wellFormed(out);
}

function sections(text: string, begin: string, end: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const b = text.indexOf(begin, from);
    if (b === -1) break;
    const e = text.indexOf(end, b);
    if (e === -1) break;
    out.push(text.slice(b + begin.length, e));
    from = e + end.length;
  }
  return out;
}

const MAP_MAX = 100_000;

function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const body of sections(text, "beginbfchar", "endbfchar"))
    for (const m of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>/g)) {
      if (map.size >= MAP_MAX) return map;
      map.set(parseInt(m[1] ?? "", 16), hexToText(m[2] ?? ""));
    }
  for (const body of sections(text, "beginbfrange", "endbfrange")) {
    for (const m of body.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f\s]*>|\[[^\]]*\])/g,
    )) {
      const lo = parseInt(m[1] ?? "", 16);
      const hi = Math.min(parseInt(m[2] ?? "", 16), lo + 65_535);
      const dst = m[3] ?? "";
      if (dst.startsWith("[")) {
        const items = [...dst.matchAll(/<([0-9A-Fa-f\s]*)>/g)];
        items.forEach((it, i) => {
          if (lo + i <= hi && map.size < MAP_MAX) map.set(lo + i, hexToText(it[1] ?? ""));
        });
      } else {
        const base = hexToText(dst.slice(1, -1));
        const last = base.length === 0 ? 0 : base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi && map.size < MAP_MAX; c++)
          map.set(c, wellFormed(base.slice(0, -1) + String.fromCharCode(last + (c - lo))));
      }
    }
  }
  return map;
}

interface FontInfo {
  cmap?: Map<number, string>;
  twoByte: boolean;
}

/** Windows-1252 for the bytes a menu uses (prices, quotes, dashes, accents); the rest is Latin-1. */
const CP1252: ReadonlyMap<number, string> = new Map([
  [0x80, "€"],
  [0x85, "…"],
  [0x91, "‘"],
  [0x92, "’"],
  [0x93, "“"],
  [0x94, "”"],
  [0x95, "•"],
  [0x96, "–"],
  [0x97, "—"],
  [0x99, "™"],
]);

// ---- content streams ----------------------------------------------------------------------------

type Operand = number | { name: string } | { str: string } | Operand[];

function literal(text: string, i: number): { value: string; end: number } {
  let depth = 0;
  let out = "";
  for (let p = i; p < text.length; p++) {
    const c = text[p] ?? "";
    if (c === "\\") {
      const n = text[++p] ?? "";
      if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(text[p + 1] ?? "x")) oct += text[++p];
        out += String.fromCharCode(parseInt(oct, 8) & 255);
      } else if (n === "n") out += "\n";
      else if (n === "r") out += "\r";
      else if (n === "t") out += "\t";
      else if (n === "b") out += "\b";
      else if (n === "f") out += "\f";
      else if (n === "\r" && text[p + 1] === "\n") p++;
      else if (n !== "\n" && n !== "\r") out += n;
    } else if (c === "(") {
      if (depth++ > 0) out += c;
    } else if (c === ")") {
      if (--depth === 0) return { value: out, end: p + 1 };
      out += c;
    } else out += c;
  }
  return { value: out, end: text.length };
}

function hexString(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 2)
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2).padEnd(2, "0"), 16));
  return out;
}

/** Tab, newline and every other control character out; the line breaks come from positions. */
function withoutControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) out += ch;
  }
  return out;
}

interface PageText {
  text: string;
  shown: number;
  unmapped: number;
  chars: number;
}

const LINE_MAX = 2000;
const PAGE_MAX = 100_000;

function interpret(content: string, fonts: ReadonlyMap<string, FontInfo>): PageText {
  const lines: string[] = [];
  let size = 12;
  let leading = 0;
  let font: FontInfo | undefined;
  let lineStartX = 0;
  let lineStartY = 0;
  let x = 0;
  let y = 0;
  let buf = "";
  let bufY = 0;
  let endX = 0;
  let shown = 0;
  let unmapped = 0;
  let chars = 0;
  let total = 0;
  const flush = (): void => {
    if (buf.trim() !== "" && total < PAGE_MAX) {
      lines.push(buf.slice(0, LINE_MAX));
      total += buf.length;
    }
    buf = "";
  };
  const decodeRaw = (raw: string): string => {
    let out = "";
    if (font?.cmap) {
      const step = font.twoByte ? 2 : 1;
      for (let i = 0; i < raw.length; i += step) {
        const code =
          step === 2 ? (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1) : raw.charCodeAt(i);
        const t = font.cmap.get(code);
        if (t === undefined) unmapped++;
        else out += t;
      }
      chars += Math.ceil(raw.length / step);
      return out;
    }
    if (font?.twoByte) {
      unmapped += Math.ceil(raw.length / 2);
      chars += Math.ceil(raw.length / 2);
      return "";
    }
    for (let i = 0; i < raw.length; i++) out += CP1252.get(raw.charCodeAt(i)) ?? raw[i];
    chars += raw.length;
    return out;
  };
  const show = (raw: string): void => {
    const piece = withoutControls(decodeRaw(raw));
    shown++;
    if (piece === "") return;
    if (buf !== "" && Math.abs(y - bufY) > size * 0.3) flush();
    if (buf === "") bufY = y;
    else {
      const gap = x - endX;
      if (gap > size * 2.5) buf += "  ";
      else if (gap > size * 0.12 && !buf.endsWith(" ")) buf += " ";
    }
    buf += piece;
    endX = x + piece.length * size * 0.5;
    x = endX;
  };
  const nextLine = (): void => {
    lineStartY -= leading || size * 1.2;
    x = lineStartX;
    y = lineStartY;
  };

  const stack: Operand[] = [];
  const push = (o: Operand): void => {
    if (stack.length >= 128) stack.shift();
    stack.push(o);
  };
  let array: Operand[] | undefined;
  const put = (o: Operand): void => {
    if (array) array.push(o);
    else push(o);
  };
  const num = (o: Operand | undefined): number => (typeof o === "number" ? o : 0);
  const str = (o: Operand | undefined): string | undefined =>
    o !== undefined && typeof o === "object" && "str" in o ? o.str : undefined;

  const op = (word: string): void => {
    switch (word) {
      case "BT":
        lineStartX = lineStartY = x = y = 0;
        break;
      case "Tf": {
        const name = stack.at(-2);
        font =
          name !== undefined && typeof name === "object" && "name" in name
            ? fonts.get(name.name)
            : undefined;
        size = Math.abs(num(stack.at(-1))) || 12;
        break;
      }
      case "TL":
        leading = Math.abs(num(stack.at(-1)));
        break;
      case "Tm":
        lineStartX = x = num(stack.at(-2));
        lineStartY = y = num(stack.at(-1));
        break;
      case "Td":
      case "TD":
        lineStartX += num(stack.at(-2));
        lineStartY += num(stack.at(-1));
        x = lineStartX;
        y = lineStartY;
        break;
      case "T*":
        nextLine();
        break;
      case "Tj": {
        const s = str(stack.at(-1));
        if (s !== undefined) show(s);
        break;
      }
      case "'":
      case '"': {
        nextLine();
        const s = str(stack.at(-1));
        if (s !== undefined) show(s);
        break;
      }
      case "TJ": {
        const list = stack.at(-1);
        if (Array.isArray(list))
          for (const item of list) {
            const s = str(item);
            if (s !== undefined) show(s);
            else if (typeof item === "number" && item < -250 && buf !== "" && !buf.endsWith(" "))
              buf += " ";
          }
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  };

  const n = content.length;
  let i = 0;
  while (i < n) {
    const c = content[i] ?? "";
    if (c <= " ") i++;
    else if (c === "%") {
      while (i < n && content[i] !== "\n" && content[i] !== "\r") i++;
    } else if (c === "(") {
      const { value, end } = literal(content, i);
      put({ str: value });
      i = end;
    } else if (c === "<" && content[i + 1] === "<") i += 2;
    else if (c === ">" && content[i + 1] === ">") i += 2;
    else if (c === "<") {
      const end = content.indexOf(">", i);
      const stop = end === -1 ? n : end;
      put({ str: hexString(content.slice(i + 1, stop)) });
      i = stop + 1;
    } else if (c === "[") {
      array = [];
      i++;
    } else if (c === "]") {
      if (array) {
        const done = array;
        array = undefined;
        push(done);
      }
      i++;
    } else if (c === "/") {
      let j = i + 1;
      while (j < n && !/[\s/<>[\]()%]/.test(content[j] ?? " ")) j++;
      put({ name: content.slice(i + 1, j) });
      i = j;
    } else {
      let j = i;
      while (j < n && !/[\s/<>[\]()%]/.test(content[j] ?? " ")) j++;
      if (j === i) j = i + 1;
      const word = content.slice(i, j);
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) put(Number(word));
      else if (!array) op(word);
      i = j;
    }
  }
  flush();
  return { text: wellFormed(lines.join("\n")), shown, unmapped, chars };
}

// ---- the file -----------------------------------------------------------------------------------

export function readPdf(bytes: Uint8Array, given: ReadLimits = {}): PdfRead {
  const limits: Required<ReadLimits> = { ...DEFAULTS, ...given };
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (text.slice(0, 1024).indexOf("%PDF-") === -1) return fail("not-a-pdf");
  if (text.slice(-1024).indexOf("%%EOF") === -1) return fail("truncated");

  const objs = new Map<number, Obj>();
  const budget = { used: 0 };
  let count = 0;
  let encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(text.slice(-8192));
  try {
    const scan = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    for (let m = scan.exec(text); m; m = scan.exec(text)) {
      if (++count > limits.maxObjects) return fail("too-complex");
      const num = Number(m[1]);
      const start = scan.lastIndex;
      const end = text.indexOf("endobj", start);
      if (end === -1) break;
      const window = text.slice(start, Math.min(end, start + 16_384));
      const key = />>\s*stream(?:\r\n|\n|\r)/.exec(window);
      if (key) {
        const dict = window.slice(0, key.index + 2);
        const from = start + key.index + key[0].length;
        const to = text.indexOf("endstream", from);
        if (to === -1) return fail("truncated");
        if (!objs.has(num)) objs.set(num, { dict, data: bytes.subarray(from, to) });
        scan.lastIndex = to + 9;
        if (/\/Type\s*\/XRef/.test(dict) && /\/Encrypt\s+\d+\s+\d+\s+R/.test(dict))
          encrypted = true;
      } else if (!objs.has(num)) objs.set(num, { dict: window });
      if (!key) scan.lastIndex = end + 6;
    }
    if (encrypted) return fail("encrypted");

    // Objects stored inside object streams.
    for (const [, obj] of [...objs]) {
      if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
      const body = decode(obj, limits, budget);
      if (body === "unsupported") continue;
      const s = Buffer.from(body).toString("latin1");
      const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
      const n = Math.min(Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? 0), limits.maxObjects);
      const pairs = [...s.slice(0, first).matchAll(/(\d+)\s+(\d+)/g)].slice(0, n);
      pairs.forEach((p, k) => {
        const id = Number(p[1]);
        const a = first + Number(p[2]);
        const b = pairs[k + 1] ? first + Number(pairs[k + 1]?.[2]) : s.length;
        if (!objs.has(id)) objs.set(id, { dict: s.slice(a, b) });
      });
    }

    // Page order: the page tree from the catalogue, else object order.
    const pages: { dict: string; resources: string | undefined }[] = [];
    let found = 0;
    const seen = new Set<number>();
    const walk = (id: number, inherited: string | undefined, depth: number): void => {
      const o = objs.get(id);
      if (!o || seen.has(id) || depth > 32 || found > limits.maxPages) return;
      seen.add(id);
      const own = valueOf(objs, o.dict, "Resources") ?? inherited;
      const kids = after(o.dict, "Kids");
      if (kids !== undefined && !/\/Type\s*\/Page(?![s\w])/.test(o.dict)) {
        for (const k of refsIn(balanced(o.dict, kids) ?? "")) walk(k, own, depth + 1);
      } else {
        found++;
        if (pages.length < limits.maxPages) pages.push({ dict: o.dict, resources: own });
      }
    };
    const catalogue = [...objs.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.dict));
    const root = catalogue
      ? refsIn((catalogue.dict.match(/\/Pages\s+\d+\s+\d+\s+R/) ?? [""])[0])
      : [];
    if (root[0] !== undefined) walk(root[0], undefined, 0);
    if (found === 0)
      for (const [id, o] of objs)
        if (/\/Type\s*\/Page(?![s\w])/.test(o.dict)) {
          found++;
          if (pages.length < limits.maxPages)
            pages.push({ dict: o.dict, resources: valueOf(objs, o.dict, "Resources") });
          void id;
        }
    if (pages.length === 0) return fail("no-text-layer");

    const fontCache = new Map<number, FontInfo>();
    const fontOf = (id: number): FontInfo => {
      const cached = fontCache.get(id);
      if (cached) return cached;
      const dict = objs.get(id)?.dict ?? "";
      const info: FontInfo = {
        twoByte: /\/Subtype\s*\/Type0/.test(dict) || /\/Encoding\s*\/Identity-[HV]/.test(dict),
      };
      const at = after(dict, "ToUnicode");
      const ref = at === undefined ? undefined : REF.exec(dict.slice(at, at + 40));
      const cm = ref ? objs.get(Number(ref[1])) : undefined;
      if (cm) {
        const body = decode(cm, limits, budget);
        if (body !== "unsupported")
          info.cmap = parseToUnicode(Buffer.from(body).toString("latin1"));
      }
      fontCache.set(id, info);
      return info;
    };

    let shown = 0;
    let unmapped = 0;
    let chars = 0;
    let unsupported = 0;
    const out: string[] = [];
    for (const page of pages) {
      const fonts = new Map<string, FontInfo>();
      const fdict = page.resources ? valueOf(objs, page.resources, "Font") : undefined;
      if (fdict)
        for (const m of fdict.matchAll(/\/([^\s/<>[\]()%]+)\s+(\d+)\s+\d+\s+R/g))
          fonts.set(m[1] ?? "", fontOf(Number(m[2])));
      const at = after(page.dict, "Contents");
      const ids =
        at === undefined
          ? []
          : refsIn(page.dict.slice(at, at + (page.dict[at] === "[" ? 4096 : 40)));
      const parts: string[] = [];
      for (const id of at === undefined
        ? []
        : page.dict[at] === "["
          ? refsIn(balanced(page.dict, at) ?? "")
          : ids.slice(0, 1)) {
        const stream = objs.get(id);
        if (!stream) continue;
        const body = decode(stream, limits, budget);
        if (body === "unsupported") {
          unsupported++;
          continue;
        }
        parts.push(Buffer.from(body).toString("latin1"));
      }
      const r = interpret(parts.join("\n"), fonts);
      shown += r.shown;
      unmapped += r.unmapped;
      chars += r.chars;
      out.push(r.text);
    }
    if (unmapped > 0 && unmapped * 3 > chars) return fail("undecodable-fonts");
    if (shown === 0) return fail(unsupported > 0 ? "unsupported-streams" : "no-text-layer");
    if (out.every((p) => p.trim() === "")) return fail("no-text-layer");
    return { ok: true, pages: out, pageCount: found, truncated: found > limits.maxPages };
  } catch (err) {
    if (err instanceof Overrun) return fail("too-complex");
    throw err;
  }
}
