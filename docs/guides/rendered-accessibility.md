# Rendered accessibility: what the browser computes

Some accessibility facts only exist after a page's styles and scripts have run: which colour is really behind a
line of text, what order the keyboard visits things in, what a screen reader would call a button. With
`--renderer playwright` ([Rendered pages](../rendered-pages.md)) Gaugeline loads the page in the browser you
installed, asks the browser for those facts, and applies five plain rules to them. No model is involved, nothing
is clicked, typed or submitted, and the browser asks for nothing a plain rendered load does not.

```sh
npx gaugeline pantry.example --renderer playwright
```

The checks are in the run only with `--renderer`. Without it there is nothing computed to look at, so they are
not there, and a run's output is unchanged. They are WCAG basics, not a full audit: a clean result means these
five rules found nothing, not that the page is accessible.

| Check                 | What it catches                                                                               | Severity    |
| --------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| `a11y-contrast`       | Text with less contrast against its background than WCAG 2 asks for                           | medium      |
| `a11y-focus-order`    | A positive `tabindex`, or keyboard focus that jumps back up the page two or more times        | medium, low |
| `a11y-names-roles`    | A control with no accessible name, or an element with a widget role the keyboard cannot reach | medium      |
| `a11y-landmarks`      | No `main` landmark, more than one, or several landmarks of a kind that nothing tells apart    | medium, low |
| `a11y-reduced-motion` | Running animation and no `prefers-reduced-motion` rule in the page's stylesheets              | medium, low |

## Contrast

For up to 250 visible text elements the browser's own computed colours are read: the text colour, and the
background found by walking up through translucent layers to an opaque one (white at the top). The WCAG 2
formula gives the ratio: **4.5 to 1** for normal text, **3 to 1** for large text (24 px, or 18.66 px and bold).
A translucent text colour is laid over its background first. The ratio is cut down to hundredths, so 4.477 is
4.47 and fails. Elements with the same colours and size are one group; the three worst are named with examples.

Text over an image or a gradient is not one colour, so its contrast is **not computed**: it is could not check,
never a pass. So is text past the 250 sampled. Disabled controls and `aria-hidden` text are left out.

## Focus order

The elements the Tab key reaches are put in the order the browser visits them (positive `tabindex` first, then
the page's order). A positive `tabindex` is a finding: it reorders the whole page. A move to a position more
than 40 pixels higher than the one before counts as a jump back; two or more are a finding, because one is
usually a skip link or a sticky bar.

## Names and roles

Each element Tab reaches needs an accessible name: its `aria-label`, the text of its `aria-labelledby`, its
`label`, the value of a submit or button input, the text (or an image's `alt`) inside it, or its `title`. And an
element with the role button, link, checkbox, switch, tab, menuitem or radio that is not natively focusable and
has no `tabindex` of 0 or more cannot be used without a mouse. A real `<button>` is both reachable and named.

## Landmarks

A page needs one `main`. Two or more landmarks of one kind (two `nav`, two `aside`) need names that tell them
apart (`aria-label`). A `header` or `footer` inside an `article`, `aside`, `main`, `nav` or `section` is not a
landmark and is not counted.

## Reduced motion

The animations the browser reports after the page settled (CSS animations, transitions and the Web Animations
API), and how many never end, against a `prefers-reduced-motion` media rule in any stylesheet the page's own
script can read. A stylesheet from another origin cannot be read, so with no rule seen and one of those present
the check says could not check. A rule written in script (`matchMedia`) is not seen.

## What it cannot say

Accessibility is mostly not computable: whether alt text is meaningful, whether a heading order helps, whether a
form's errors are clear. These rules cannot see colour used as the only signal, text inside images, content that
appears only after a click (Gaugeline clicks nothing), or anything past the caps (250 text elements, 300
focusable, 50 landmarks). Use a screen reader and the keyboard on the pages that matter.

## Example: Corner Pantry

Corner Pantry is an invented shop. Its page has pale grey text, a link with `tabindex="2"`, an icon button with
no name, no `main` landmark, and a spinner that never stops, with no reduced-motion rule.

```text title="Terminal" untested="Needs a browser installed on the machine. packages/renderer/src/__tests__/a11y.e2e.test.ts runs the probe in a real browser over two invented pages, and packages/cli/src/__tests__/a11y-rendered.test.ts runs this command in memory with a stand-in browser that answers with the invented facts of this example, and checks that every line below is in what it prints."
$ npx gaugeline corner-pantry.example --renderer playwright
```

```text title="Output (other checks' lines left out)"
! Text is too faint to read against its background
    1 text element falls short of WCAG contrast: "Jam, bread and tea" at 1.60:1 (needs 4.5:1, #cccccc on #ffffff)
! Keyboard focus does not follow the page
    Positive tabindex values reorder keyboard focus: tabindex 2 on "Order".
! The page's landmarks are missing or unclear
    The page has no main landmark (a main element), so a screen reader user cannot jump to its content.
! A control has no name, or a widget cannot be reached
    1 control the keyboard reaches has no accessible name: <button>.
! The page animates and does not honour reduced motion
    2 animations run on the page (1 never ends) and no prefers-reduced-motion rule was found in its stylesheets.
```

## For developers

The renderer's request takes `expose.a11y`, and its answer then carries `a11y`: lists of text samples, focusable
elements in Tab order, unreachable widgets, landmarks and a motion read, from one expression the browser runs
(`packages/renderer/src/a11y-script.ts`). It only reads: it focuses nothing and asks for no address. What the
page returns is data: `readA11y` in `packages/core/src/a11y/read.ts` cuts it to those shapes, cleans every string
and caps every list before a check sees it. The rules are pure functions in `packages/core/src/a11y/analyse.ts`
and the checks are `packages/core/src/checks/a11y-rendered.ts`.
