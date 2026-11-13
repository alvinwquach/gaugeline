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
