# Framework speed causes: what a framework leaves behind

Frameworks and page builders make it easy to ship a heavy page. Four causes show up again and again, and each is
a plain rule over the page Gaugeline already reads, with no model and no request of its own:

| Check                     | What it catches                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `perf-webgl-autostart`    | A 3D (WebGL) scene that starts as soon as the page loads, with no click or tap to start it             |
| `perf-lcp-image`          | The first large image is lazy-loaded, is neither preloaded nor marked high priority, or is oversized   |
| `perf-animation-reflow`   | An animation that makes the browser lay the page out on every frame                                    |
| `perf-no-lowend-fallback` | A heavy page (3D, autoplaying video, an animation library) that never looks at Save-Data or the device |

They run with the page check and need nothing but the page and the site's own script files, which the run
already fetches once for the key check and shares: these checks make no request of their own. The 3D scene check
also reads the rendered page when you run with `--renderer playwright` ([Rendered pages](../rendered-pages.md)).

## The 3D scene that starts without input

A 3D library (three.js, Babylon.js, PlayCanvas, react-three-fiber, Spline) or a WebGL call in the page's code,
beside a canvas, is a scene set up at load. Gaugeline gives the page no input, so a scene that is set up at load
has started without any. If the page asks the visitor to "click to start", "tap to enter" or "press play", the
scene waits and nothing is reported. With `--renderer playwright` the canvas must exist in the rendered page
(a library that draws nothing is not reported) and its size is shown.

**Fix.** Show a still picture first and start the scene when it is tapped or scrolled into view, load the library
only then, and skip it for visitors who ask for less data or motion.

## The first large image

The first large content image on the page is usually the largest paint, the number a page's speed is judged by.
Gaugeline takes the first image outside a header, nav or footer that is not named like a logo or icon and is not
tiny, and says so: it is a guess at which image the browser picks, not a measurement.

- **Lazy** (`loading="lazy"`): the browser waits to fetch the image. Medium.
- **Not preloaded and not high priority** (no `fetchpriority="high"`, no preload link for its address): the
  browser finds it late. Low.
- **Oversized**: its address asks for at least twice the width it is shown at and 1600 pixels or more (a `w=`
  parameter or a Next.js image address), or 2560 pixels when there is no width. Medium.

**Fix.** Take `loading="lazy"` off the first large image, add `fetchpriority="high"` or a preload link, and ask
for it at about the width it is shown.

## Animation that lays the page out

Layout is the most expensive thing a browser does each frame. The check reports the layout properties (position,
size, margin, padding, font size) that the page's own `<style>` keyframes animate or a transition names, and
`transition: all`. That is low. It also reports a script with an animation loop (`requestAnimationFrame`) that
reads a layout value (`offsetWidth`, `getBoundingClientRect`, `getComputedStyle`) and sets a style close to the
same call, which forces a second layout each frame. That is medium, counted once per script. Stylesheet files and
scripts from other sites are not read, and a script that cannot be read is could-not-check.

**Fix.** Animate `transform` and `opacity`, name the properties a transition changes, and in a loop read
first and write after.

## No fallback for a small phone

A page that loads a 3D scene, an autoplaying video or an animation library (gsap, lottie, anime, framer-motion)
and whose own scripts and styles never read `saveData`, `Save-Data`, `prefers-reduced-data`, `deviceMemory`,
`hardwareConcurrency` or `effectiveType` gives a small phone on a slow connection the same heavy load as a
desktop. Low. A script of the site that cannot be read, or was cut, makes this could-not-check, never a finding;
scripts from other sites are not read, so a fallback only there is not seen.

**Fix.** Read the hints before starting the heavy part and send a still picture when they say the visitor is
low on data or power.

## What none of this can say

These are rules over the page as sent and its own scripts. They cannot see which image a browser actually picks,
what a minified third-party bundle does, or how fast the page feels to a visitor. `--pagespeed` reports what real
visitors measured, and `--attribution` finds which change makes a page faster, in their own guides once they
merge.

## Example: a bakery with all four

Quillfeather Bakery is invented. Its page sets a 3D scene up at load with no start step, its first image is lazy
and asked for at 3840 pixels for an 800 pixel slot, a keyframes rule and an animation loop both move layout, and
nothing reads the visitor's data saver.

<!-- fixture: framework-causes -->

```sh title=Terminal
$ npx gaugeline quillfeather.example
```

```text title=Output
! Images are requested at an enormous width
    1 image is offered at 3840 pixels or wider: https://quillfeather.example/hero.png?w=3840 (3840w)
! An animation makes the browser lay the page out on every frame
    The page's own styles animate layout properties (left), so each frame makes the browser lay the page out again. Stylesheets in separate files are not read. 1 script has an animation loop that reads a layout value and then sets a style, so each frame makes the browser lay the page out twice.
! The page's first large image is lazy, late or oversized
    The first large image, https://quillfeather.example/hero.png?w=3840, is lazy-loaded, so the browser waits to fetch it; and is asked for at 3840 pixels wide but shown 800 wide: it is probably what the page's largest paint waits for.
! A 3D scene starts as soon as the page loads
    A 3D scene starts as soon as the page loads: new THREE.WebGLRenderer is called, and no "click to start" or "tap to enter" step was found, so every visitor pays for it before any input.
· Images use older, heavier file formats
    1 of 1 sampled images are JPEG, PNG or GIF only: /hero.png?w=3840
· A heavy page has no Save-Data or low-end-device fallback
    The page loads a 3D scene and an autoplaying video and nothing in its own scripts or styles reads the visitor's data saver (Save-Data), device memory, core count or connection type, so a small phone on a slow connection gets the same heavy load as a desktop. Scripts from other sites are not read.
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

6 to look at, none to fix first.
```

The fixture is the invented `packages/fixtures/sites/framework-causes`, and its passing copy is
`framework-causes-clean`. The output is asserted by `packages/cli/src/__tests__/perf-causes.test.ts` and checked
by `pnpm docs:examples`.
