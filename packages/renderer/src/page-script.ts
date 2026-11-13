/**
 * The two small scripts that run inside the page. Both are written here and sent to the browser as text or
 * as a function: nothing the page sends is ever run by Gaugeline. What comes back is data (rule 11).
 */

/** The name the page can call to say a form was submitted. Counting only; it takes no argument and sends nothing. */
export const FORM_COUNTER = "__gaugelineForm";

/**
 * Runs before any script of the page, in every frame. A form the page submits (by script or by a
 * submit event) is stopped and counted: nothing here types into a form or clicks a button, so a form that
 * is submitted was submitted by the page itself. A GET form would be a read, but Gaugeline looks and
 * never pokes (rule 14): the network gate is the wall, and this keeps a page from navigating by form.
 */
export const FORM_GUARD = `(() => {
  const note = () => { try { window.${FORM_COUNTER}(); } catch (e) { /* the counter is not there */ } };
  window.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    note();
  }, true);
  HTMLFormElement.prototype.submit = note;
  HTMLFormElement.prototype.requestSubmit = note;
})();`;

/**
 * Runs before any script of the page, in every frame. WebRTC, WebTransport and media capture open UDP
 * sockets and microphones outside the browser's HTTP stack, so the gate and the closed proxy never see them:
 * the browser is also started with WebRTC limited to proxied UDP (and the proxy goes nowhere), and these
 * names are taken away so a page that asks gets a TypeError. A hostile page may recover a name from a
 * frame; the launch flag and the closed proxy are what stop the packets.
 */
export const NETWORK_GUARD = `(() => {
  const gone = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate", "WebTransport"];
  for (const name of gone) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (e) { /* kept */ }
  }
  for (const name of ["mediaDevices", "getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
    try { Object.defineProperty(navigator, name, { value: undefined, configurable: false, writable: false }); } catch (e) { /* kept */ }
  }
})();`;

export interface DomRead {
  title: string;
  text: string;
  links: { href: string; text: string }[];
  html: string;
  url: string;
}

export interface DomAsk {
  text: boolean;
  links: boolean;
  html: boolean;
  /** Characters of text to bring back (one more than kept, so a cut is seen). */
  maxText: number;
  maxLinks: number;
  maxHtml: number;
}

/**
 * The expression evaluated in the page (the project's types have no DOM, so it is text). Cuts at the
 * source, so a huge page does not cross the wire before it is cut. The page can rewrite what this reads:
 * the answer is data, not a fact about the site.
 */
export const readDomExpression = (ask: DomAsk): string => `((ask) => ({
  title: String(document.title || "").slice(0, 500),
  text: ask.text ? String((document.body && document.body.innerText) || "").slice(0, ask.maxText) : "",
  links: ask.links
    ? Array.from(document.querySelectorAll("a[href]")).slice(0, ask.maxLinks).map((a) => ({
        href: String(a.href).slice(0, 2000),
        text: String(a.innerText || a.getAttribute("aria-label") || "").slice(0, 300),
      }))
    : [],
  html: ask.html ? String(document.documentElement.outerHTML).slice(0, ask.maxHtml) : "",
  url: String(location.href),
}))(${JSON.stringify(ask)})`;

/**
 * For the click observer. Runs before the page's own scripts, in every frame. It hands what is pushed to
 * `dataLayer` (a plain object, or the arguments of a `gtag('event', name, {...})` call, kept as a flat object
 * of text, numbers and booleans), and it cancels the default action of a click on a link to another site: the
 * page's own click handlers still run and can still report, but the browser does not leave for a site the
 * plan did not name. `__glMark` is new in every document, so a click that loaded a new page can be told.
 */
export const OBSERVER_SCRIPT = `(() => {
  const grab = (x) => {
    try {
      let o = x;
      if (Object.prototype.toString.call(x) === "[object Arguments]" || Array.isArray(x)) {
        const a = Array.from(x);
        if (a[0] === "event" && typeof a[1] === "string") {
          o = Object.assign({ event: a[1] }, typeof a[2] === "object" && a[2] !== null ? a[2] : {});
        } else return;
      }
      if (typeof o !== "object" || o === null) return;
      const out = {};
      let n = 0;
      for (const k of Object.keys(o)) {
        if (n++ >= 30) break;
        const v = o[k];
        if (typeof v === "string") out[k] = v.slice(0, 300);
        else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
      }
      if (typeof window.__glPush === "function") window.__glPush({ t: Date.now(), x: out });
    } catch (e) { /* a page object that will not read is not an event */ }
  };
  const hook = (arr) => {
    if (!Array.isArray(arr) || arr.__gl) return arr;
    const push = arr.push;
    Object.defineProperty(arr, "__gl", { value: true });
    arr.push = function () {
      for (const a of arguments) grab(a);
      return push.apply(this, arguments);
    };
    return arr;
  };
  let current = hook([]);
  Object.defineProperty(window, "dataLayer", { configurable: true, get: () => current, set: (v) => { current = hook(v); } });
  Object.defineProperty(window, "__glMark", { value: Math.random() });
  window.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (a && a.origin !== location.origin) e.preventDefault();
  }, true);
})();`;

export interface TargetInspection {
  found: boolean;
  isLink?: boolean;
  inForm?: boolean;
  visible?: boolean;
}

/** Evaluated in the page: is this still a visible link that is not in a form? Reads, never acts. */
export const inspectExpression = (path: string): string => `((path) => {
  let el;
  try { el = document.querySelector(path); } catch (e) { return { found: false }; }
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    found: true,
    isLink: el.tagName === "A" && el.hasAttribute("href"),
    inForm: !!el.closest("form"),
    visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[hidden]"),
  };
})(${JSON.stringify(path)})`;

/** The name the page calls to hand a captured push to the observer (it survives a navigation: the push is kept outside the page). */
export const PUSH_BINDING = "__glPush";
/** This document's mark: gone, or another, when a click loaded a new page. */
export const READ_MARK = "window.__glMark === undefined ? null : window.__glMark";
export const READ_NOW = "Date.now()";

/** The index in `paths` of the element that has focus, -1 for another element, -2 for none (the end of the page). */
export const focusExpression = (paths: readonly string[]): string => `((paths) => {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return -2;
  for (let i = 0; i < paths.length; i++) {
    try { if (a.matches(paths[i])) return i; } catch (e) { /* a path that will not parse matches nothing */ }
  }
  return -1;
})(${JSON.stringify(paths)})`;

/** The link in the page whose text is exactly this (the consent line the plan names), as a path, or null. */
export const findLinkByText = (text: string): string => `((want) => {
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const links = Array.from(document.querySelectorAll("a[href]"));
  const el = links.find((a) => norm(a.innerText || a.getAttribute("aria-label")) === norm(want) && !a.closest("form"));
  if (!el) return null;
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    const same = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName) : [node];
    parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + (same.indexOf(node) + 1) + ")");
    node = node.parentElement;
  }
  return parts.join(" > ");
})(${JSON.stringify(text)})`;
