/**
 * The expression that runs in the page and reads what the browser computed for accessibility (N16): the colours
 * it resolved for text, the order Tab visits things, the names it can give them, the landmarks and whether
 * motion has a reduced-motion rule. It is written here and sent to the browser as text: nothing the page sends is
 * ever run by Gaugeline. It reads, it writes nothing, clicks nothing, focuses nothing and asks for no address
 * (a stylesheet from another origin throws when read, and that is counted, not followed). What comes back is
 * data from the site: the core cuts it to a shape and a size before anything reads it (`readA11y`).
 */
const A11Y_EXPRESSION = `(() => {
  const MAX_TEXT = 250, MAX_FOCUS = 300, MAX_UNREACHABLE = 50, MAX_LANDMARKS = 50;
  const clip = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n);
  const cs = (el) => getComputedStyle(el);
  const shown = (el) => {
    const s = cs(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const color = (s) => {
    const m = /^rgba?\\(([^)]+)\\)$/.exec(String(s).trim());
    if (!m) return null;
    const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    const a = p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1;
    return [p[0], p[1], p[2], a];
  };
  // The colour behind an element: walk up through translucent layers to an opaque one (white if none),
  // and give up (null) at a background image or gradient, which is not one colour.
  const behind = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = cs(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = color(s.backgroundColor);
      if (!c) return null;
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let r = 255, g = 255, b = 255;
    for (let i = layers.length - 1; i >= 0; i--) {
      const c = layers[i];
      r = c[0] * c[3] + r * (1 - c[3]);
      g = c[1] * c[3] + g * (1 - c[3]);
      b = c[2] * c[3] + b * (1 - c[3]);
    }
    return [r, g, b];
  };
  const ownText = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return clip(t, 60);
  };

  const text = [];
  let textOmitted = 0;
  let visited = 0;
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (++visited > 20000) break;
    if (!ownText(el) || el.closest("[disabled],script,style,noscript,[aria-hidden='true']")) continue;
    if (!shown(el)) continue;
    if (text.length >= MAX_TEXT) { textOmitted++; continue; }
    const s = cs(el);
    const fg = color(s.color);
    if (!fg) continue;
    text.push({
      tag: el.tagName.toLowerCase(),
      text: ownText(el),
      fg,
      bg: behind(el),
      px: parseFloat(s.fontSize) || 0,
      bold: (parseInt(s.fontWeight, 10) || 400) >= 700,
    });
  }

  const labelOf = (el) => {
    const byIds = (ids) => ids.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ""; }).join(" ");
    let name = el.getAttribute("aria-label");
    if (!name && el.getAttribute("aria-labelledby")) name = byIds(el.getAttribute("aria-labelledby"));
    if (!name && el.labels && el.labels.length) name = Array.from(el.labels).map((l) => l.textContent).join(" ");
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (!name && tag === "input" && (type === "submit" || type === "button" || type === "reset")) name = el.value || (type === "submit" ? "Submit" : "");
    if (!name && tag === "input" && type === "image") name = el.getAttribute("alt");
    if (!name && tag !== "input" && tag !== "select" && tag !== "textarea") {
      name = el.textContent;
      if (!clip(name, 5)) {
        const img = el.querySelector("img[alt],svg[aria-label],[aria-label]");
        name = img ? (img.getAttribute("alt") || img.getAttribute("aria-label")) : "";
      }
    }
    if (!name) name = el.getAttribute("title");
    return clip(name, 80);
  };
  const NATIVE = "a[href],area[href],button,input:not([type=hidden]),select,textarea,summary,iframe,[contenteditable=''],[contenteditable='true']";
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return clip(explicit.split(/\\s+/)[0], 30);
    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "area") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return t === "checkbox" ? "checkbox" : t === "radio" ? "radio" : (t === "submit" || t === "button" || t === "reset" || t === "image") ? "button" : "textbox";
    }
    return tag;
  };
  const candidates = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(NATIVE + ",[tabindex]")) {
    if (seen.has(el) || !shown(el) || el.disabled) continue;
    const ti = el.hasAttribute("tabindex") ? parseInt(el.getAttribute("tabindex"), 10) : null;
    if (ti !== null && ti < 0) continue;
    seen.add(el);
    candidates.push({ el, ti: Number.isFinite(ti) ? ti : null, index: candidates.length });
  }
  // Tab order: positive tabindex first, ascending, then the rest in document order.
  candidates.sort((a, b) => {
    const pa = a.ti > 0 ? a.ti : Infinity, pb = b.ti > 0 ? b.ti : Infinity;
    return pa !== pb ? pa - pb : a.index - b.index;
  });
  const focusables = candidates.slice(0, MAX_FOCUS).map(({ el, ti }) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), role: roleOf(el), name: labelOf(el), tabindex: ti, x: r.left + scrollX, y: r.top + scrollY };
  });

  const unreachable = [];
  for (const el of document.querySelectorAll("[role=button],[role=link],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[role=radio]")) {
    if (seen.has(el) || el.matches(NATIVE) || !shown(el)) continue;
    const ti = el.hasAttribute("tabindex") ? parseInt(el.getAttribute("tabindex"), 10) : null;
    if (ti !== null && ti >= 0) continue;
    if (unreachable.length >= MAX_UNREACHABLE) break;
    unreachable.push({ tag: el.tagName.toLowerCase(), role: roleOf(el), name: labelOf(el) });
  }

  const landmarks = [];
  const inSection = (el) => !!el.closest("article,aside,main,nav,section");
  const LM = "main,[role=main],nav,[role=navigation],header,[role=banner],footer,[role=contentinfo],aside,[role=complementary],[role=search],form[aria-label],form[aria-labelledby],[role=form],section[aria-label],section[aria-labelledby],[role=region]";
  for (const el of document.querySelectorAll(LM)) {
    if (!shown(el)) continue;
    const tag = el.tagName.toLowerCase();
    let role = el.getAttribute("role");
    if (!role) {
      role = tag === "main" ? "main" : tag === "nav" ? "navigation" : tag === "aside" ? "complementary"
        : tag === "header" ? (inSection(el) ? "" : "banner") : tag === "footer" ? (inSection(el) ? "" : "contentinfo")
        : tag === "form" ? "form" : tag === "section" ? "region" : "";
    }
    if (!role) continue;
    if (landmarks.length >= MAX_LANDMARKS) break;
    const named = el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") ? labelOf(el) : "");
    landmarks.push({ role: clip(role.split(/\\s+/)[0], 30), name: clip(named, 80) });
  }

  let animations = 0, endless = 0, reducedMotionRule = false, unreadableSheets = 0;
  try {
    const all = typeof document.getAnimations === "function" ? document.getAnimations() : [];
    animations = all.length;
    for (const a of all) {
      try { if (a.effect && a.effect.getComputedTiming().iterations === Infinity) endless++; } catch (e) { /* not readable */ }
    }
  } catch (e) { /* no animations api */ }
  const scan = (rules) => {
    for (const rule of rules) {
      if (rule.media && /prefers-reduced-motion/i.test(rule.media.mediaText || "")) reducedMotionRule = true;
      if (rule.cssRules && rule.cssRules.length) scan(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try { scan(sheet.cssRules); } catch (e) { unreadableSheets++; }
  }
  return { text, textOmitted, focusables, unreachable, landmarks, motion: { animations, endless, reducedMotionRule, unreadableSheets } };
})()`;

/** The expression to evaluate: this package's own constant, named as a builder so the scan can see it is not the page's. */
export const a11yExpression = (): string => A11Y_EXPRESSION;
