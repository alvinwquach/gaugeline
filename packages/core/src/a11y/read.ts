import { sanitise } from "../untrusted.js";
import type {
  A11yRead,
  Focusable,
  Landmark,
  MotionRead,
  Rgba,
  TextSample,
  UnreachableWidget,
} from "./types.js";

/** The most of each list kept; the page's probe cuts at the same numbers, so these are the second wall. */
export const A11Y_LIMITS = Object.freeze({
  text: 250,
  focusables: 300,
  unreachable: 50,
  landmarks: 50,
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const channel = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1_000_000) : 0;
const short = (v: unknown, max: number): string =>
  typeof v === "string" ? sanitise(v, max).text : "";
/** A position in CSS pixels, whole, within a hundred thousand either way; anything else is 0. */
const coord = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100_000 ? Math.round(v) : 0;
const tag = (v: unknown): string =>
  short(v, 20)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");

function rgba(v: unknown): Rgba | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const [r, g, b] = [channel(v[0], 255), channel(v[1], 255), channel(v[2], 255)];
  const a = v.length > 3 ? channel(v[3], 1) : 1;
  return r === undefined || g === undefined || b === undefined || a === undefined
    ? undefined
    : [r, g, b, a];
}

/**
 * The page's answer cut to its shape. The page can write anything into what the probe returns (its own scripts
 * run first), so a field that is not the expected kind is dropped, every string is cleaned and cut, and every
 * list is capped. Never throws: a page that returns rubbish gives empty lists.
 */
export function readA11y(raw: unknown): A11yRead {
  const r = isRecord(raw) ? raw : {};
  const text: TextSample[] = [];
  for (const t of list(r.text, A11Y_LIMITS.text)) {
    if (!isRecord(t)) continue;
    const fg = rgba(t.fg);
    const bgRaw = t.bg === null ? null : rgba(t.bg);
    const px = channel(t.px, 1000);
    if (!fg || bgRaw === undefined || px === undefined || px === 0) continue;
    text.push({
      tag: tag(t.tag),
      text: short(t.text, 60),
      fg,
      bg: bgRaw === null ? null : [bgRaw[0], bgRaw[1], bgRaw[2]],
      px,
      bold: t.bold === true,
    });
  }
  const focusables: Focusable[] = [];
  for (const f of list(r.focusables, A11Y_LIMITS.focusables)) {
    if (!isRecord(f)) continue;
    const ti =
      typeof f.tabindex === "number" && Number.isFinite(f.tabindex) ? Math.trunc(f.tabindex) : null;
    focusables.push({
      tag: tag(f.tag),
      role: short(f.role, 30).toLowerCase(),
      name: short(f.name, 80),
      tabindex: ti,
      x: coord(f.x),
      y: coord(f.y),
    });
  }
  const unreachable: UnreachableWidget[] = [];
  for (const u of list(r.unreachable, A11Y_LIMITS.unreachable)) {
    if (!isRecord(u)) continue;
    unreachable.push({
      tag: tag(u.tag),
      role: short(u.role, 30).toLowerCase(),
      name: short(u.name, 80),
    });
  }
  const landmarks: Landmark[] = [];
  for (const l of list(r.landmarks, A11Y_LIMITS.landmarks)) {
    if (!isRecord(l)) continue;
    landmarks.push({ role: short(l.role, 30).toLowerCase(), name: short(l.name, 80) });
  }
  const m = isRecord(r.motion) ? r.motion : {};
  const motion: MotionRead = {
    animations: count(m.animations),
    endless: count(m.endless),
    reducedMotionRule: m.reducedMotionRule === true,
    unreadableSheets: count(m.unreadableSheets),
  };
  return {
    text,
    textOmitted: count(r.textOmitted),
    focusables,
    unreachable,
    landmarks,
    motion,
  };
}
