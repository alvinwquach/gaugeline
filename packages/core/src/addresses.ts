import { isIP } from "node:net";

/** Byte offset of an IPv4 address embedded at the end of an IPv6 address. */
const V4_TAIL = 12;

/**
 * Which addresses Gaugeline will not connect to unless allowPrivate is set: anything that is not
 * on the public internet. A checked site must never be able to point Gaugeline at the machine it
 * runs on, the local network, or a cloud metadata service (169.254.169.254).
 */
export type BlockedRange =
  | "loopback"
  | "private"
  | "link-local"
  | "cgnat"
  | "unspecified"
  | "multicast"
  | "broadcast"
  | "unique-local";

function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? bytes : undefined;
}

/** 16 bytes, or undefined. Accepts "::", embedded IPv4 tails and zone ids ("fe80::1%eth0"). */
export function parseIPv6(input: string): number[] | undefined {
  const text = input.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (isIP(text) !== 6) return undefined;
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return undefined;
    tail = v4;
    head = text.slice(0, lastColon + 1) + "0:0";
  }
  const [left = "", right] = head.split("::");
  const groups = (s: string) => (s === "" ? [] : s.split(":").map((g) => Number.parseInt(g, 16)));
  const l = groups(left);
  const r = right === undefined ? [] : groups(right);
  const fill = right === undefined ? 0 : 8 - l.length - r.length;
  const all = [...l, ...Array.from({ length: fill }, () => 0), ...r];
  if (all.length !== 8) return undefined;
  const bytes = all.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function classifyIPv4(b: number[]): BlockedRange | undefined {
  const [a = 0, c = 0] = b;
  if (a === 0) return "unspecified"; // 0.0.0.0/8, "this network"
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && c >= 16 && c <= 31) return "private";
  if (a === 192 && c === 168) return "private";
  if (a === 169 && c === 254) return "link-local"; // includes 169.254.169.254
  if (a === 100 && c >= 64 && c <= 127) return "cgnat";
  if (a >= 224 && a <= 239) return "multicast";
  if (b.every((x) => x === 255)) return "broadcast";
  return undefined;
}

function classifyIPv6(b: number[]): BlockedRange | undefined {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return "unspecified"; // ::
  if (zero(0, 15) && b[15] === 1) return "loopback"; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded IPv4 address.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff)
    return classifyIPv4(b.slice(V4_TAIL)) ?? undefined;
  if (zero(0, 12)) return classifyIPv4(b.slice(V4_TAIL));
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) also carry an IPv4 address.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12))
    return classifyIPv4(b.slice(V4_TAIL));
  if (b[0] === 0x20 && b[1] === 0x02) return classifyIPv4(b.slice(2, 6));
  const first = b[0] ?? 0;
  const second = b[1] ?? 0;
  if ((first & 0xfe) === 0xfc) return "unique-local"; // fc00::/7
  if (first === 0xfe && (second & 0xc0) === 0x80) return "link-local"; // fe80::/10
  if (first === 0xff) return "multicast"; // ff00::/8
  return undefined;
}

/** The blocked range an IP address falls in, or undefined for a public address. */
export function blockedRange(address: string): BlockedRange | undefined {
  const text = address.replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(text);
  if (v4 && isIP(text) === 4) return classifyIPv4(v4);
  const v6 = parseIPv6(text);
  return v6 ? classifyIPv6(v6) : undefined;
}

export function isBlockedAddress(address: string): boolean {
  return blockedRange(address) !== undefined;
}
