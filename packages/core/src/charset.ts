/**
 * Decode a response body. The charset comes from the Content-Type header when it names one,
 * otherwise from a <meta charset> or http-equiv declaration in the first 1024 bytes, otherwise
 * UTF-8. A UTF-8 byte order mark is dropped.
 */
export function charsetFromContentType(contentType: string | undefined): string | undefined {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? "");
  return m?.[1]?.toLowerCase();
}

export function sniffMetaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return direct?.[1]?.toLowerCase();
}

export function decodeBody(bytes: Uint8Array, contentType?: string): string {
  const candidates = [charsetFromContentType(contentType), sniffMetaCharset(bytes), "utf-8"];
  for (const label of candidates) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // unknown label: try the next one
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}
