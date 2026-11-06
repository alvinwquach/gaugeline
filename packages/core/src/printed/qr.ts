import jsQR from "jsqr";
import { decodePng, PngError } from "./png.js";

export type QrRead = { ok: true; text: string } | { ok: false; reason: string };

/**
 * The address a printed QR code holds, read from a PNG on this computer: no network call. A code
 * too blurred, too small or missing is "couldn't read", never a guess.
 */
export function readQr(bytes: Uint8Array): QrRead {
  let image;
  try {
    image = decodePng(bytes);
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof PngError
          ? `the image couldn't be read: ${err.message}`
          : "the image couldn't be read",
    };
  }
  const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
  if (!code || code.data.trim() === "")
    return { ok: false, reason: "no QR code could be read (blurred, too small, or not there)" };
  return { ok: true, text: code.data.trim() };
}
