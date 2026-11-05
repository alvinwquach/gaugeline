/** Replace or compare a generated block between <!-- name:start --> and <!-- name:end --> markers. */
export type BlockResult = { ok: true; text: string } | { ok: false; error: string };

export function markers(name: string): { start: string; end: string } {
  return { start: `<!-- ${name}:start -->`, end: `<!-- ${name}:end -->` };
}

/**
 * Put `block` between the markers. Everything outside them is returned byte for byte. Line endings
 * in the file are kept: a CRLF file gets a CRLF block.
 */
export function replaceBlock(text: string, name: string, block: string): BlockResult {
  const { start, end } = markers(name);
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s === -1 || e === -1) {
    const missing = [s === -1 ? start : undefined, e === -1 ? end : undefined]
      .filter(Boolean)
      .join(" and ");
    return {
      ok: false,
      error: `Marker ${missing} not found. Add both markers around the generated table.`,
    };
  }
  if (e < s) return { ok: false, error: `${end} comes before ${start}.` };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = block.replace(/\r\n/g, "\n").split("\n").join(eol);
  return {
    ok: true,
    text: `${text.slice(0, s + start.length)}${eol}${body}${eol}${text.slice(e)}`,
  };
}

/** First differing line between what the file holds and what it should hold, for the error. */
export function firstDifference(actual: string, expected: string): string | undefined {
  const a = actual.replace(/\r\n/g, "\n").split("\n");
  const b = expected.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i])
      return `line ${i + 1}: expected ${JSON.stringify(b[i] ?? "")}, found ${JSON.stringify(a[i] ?? "")}`;
  }
  return undefined;
}

export function checkBlock(text: string, name: string, block: string): BlockResult {
  const replaced = replaceBlock(text, name, block);
  if (!replaced.ok) return replaced;
  const diff = firstDifference(text, replaced.text);
  return diff === undefined
    ? { ok: true, text }
    : { ok: false, error: `The ${name} block is out of date (${diff}). Run pnpm docs:flags.` };
}
