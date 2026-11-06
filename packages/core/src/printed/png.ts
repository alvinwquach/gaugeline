import { unzlibSync } from "fflate";

/**
 * A small PNG reader for QR images: 8-bit greyscale, grey + alpha, RGB, RGBA and palette images
 * (1, 2, 4 or 8 bits per index), not interlaced. Enough for a printed code saved from a design
 * tool or a phone; anything else is reported as unreadable rather than guessed at.
 */
export interface Rgba {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, rows top to bottom. */
  data: Uint8ClampedArray;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export class PngError extends Error {}

const u32 = (b: Uint8Array, at: number) =>
  ((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): Rgba {
  if (!SIGNATURE.every((v, i) => bytes[i] === v)) throw new PngError("not a PNG file");
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at) >>> 0;
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (name === "IHDR") {
      width = u32(body, 0) >>> 0;
      height = u32(body, 4) >>> 0;
      depth = body[8] ?? 0;
      type = body[9] ?? -1;
      if ((body[12] ?? 0) !== 0) throw new PngError("interlaced PNGs aren't read");
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") transparency = body;
    else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
    at += 12 + length;
  }
  const channels = CHANNELS[type];
  if (channels === undefined || width === 0 || height === 0) throw new PngError("no image header");
  if (type === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8)
    throw new PngError(`${depth}-bit PNGs of this kind aren't read`);
  if (width * height > 25_000_000) throw new PngError("the image is too large");
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(joined);
  } catch {
    throw new PngError("the image data is damaged");
  }
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (stride + 1) * height) throw new PngError("the image data is short");
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? (pixels[out + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (pixels[out - stride + x] ?? 0) : 0;
      const corner = y > 0 && x >= bpp ? (pixels[out - stride + x - bpp] ?? 0) : 0;
      const v = line[x] ?? 0;
      pixels[out + x] =
        filter === 1
          ? v + left
          : filter === 2
            ? v + up
            : filter === 3
              ? v + ((left + up) >> 1)
              : filter === 4
                ? v + paeth(left, up, corner)
                : v;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const row = y * stride;
      if (type === 3) {
        const bit = x * depth;
        const index =
          ((pixels[row + (bit >> 3)] ?? 0) >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        data[i] = palette?.[index * 3] ?? 0;
        data[i + 1] = palette?.[index * 3 + 1] ?? 0;
        data[i + 2] = palette?.[index * 3 + 2] ?? 0;
        data[i + 3] = transparency?.[index] ?? 255;
      } else {
        const p = row + x * channels;
        const grey = type === 0 || type === 4;
        data[i] = pixels[p] ?? 0;
        data[i + 1] = grey ? (pixels[p] ?? 0) : (pixels[p + 1] ?? 0);
        data[i + 2] = grey ? (pixels[p] ?? 0) : (pixels[p + 2] ?? 0);
        data[i + 3] =
          type === 4 ? (pixels[p + 1] ?? 255) : type === 6 ? (pixels[p + 3] ?? 255) : 255;
      }
    }
  return { width, height, data };
}
