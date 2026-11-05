/**
 * The number of a tel: link written with spaces or brackets, or undefined. RFC 3966 allows no
 * spaces in a tel URI; it does allow "(" and ")" as visual separators, but some diallers and
 * click-to-call tools mishandle them, so both are reported. "-" and "." pass.
 */
export function badTelNumber(href: string): string | undefined {
  if (!/^tel:/i.test(href)) return undefined;
  let number: string;
  try {
    number = decodeURIComponent(href.slice(4));
  } catch {
    number = href.slice(4);
  }
  return /[\s()]/.test(number) ? number.trim() : undefined;
}
