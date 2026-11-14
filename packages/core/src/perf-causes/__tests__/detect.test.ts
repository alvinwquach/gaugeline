import { describe, expect, it } from "vitest";
import {
  animatedLayoutProperties,
  hasLowEndFallback,
  heavyMotionKinds,
  heroImage,
  layoutThrashLoops,
  startGate,
  webglEvidence,
} from "../detect.js";

const BASE = "https://quillfeather.example/";

describe("heroImage: the first large content image and how it is loaded", () => {
  const doc = (body: string, head = "") =>
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

  it("skips the logo, icons, tiny pictures and anything in the header, nav or footer", () => {
    const h = heroImage(
      doc(
        `<header><img src="/hero-in-header.jpg" width="1200"></header><nav><img src="/n.jpg"></nav>
         <img src="/logo.svg" width="400"><img src="/icons/cart.png"><img src="/dot.gif" width="1" height="1">
         <img src="/pixel.png" width="40" height="40"><main><img src="/loaves.jpg" width="1200" height="800"></main>
         <footer><img src="/f.jpg"></footer>`,
      ),
      BASE,
    );
    expect(h?.src).toBe("https://quillfeather.example/loaves.jpg");
    expect(h?.width).toBe(1200);
  });

  it("is undefined when the page has no such image", () => {
    expect(heroImage(doc("<p>No pictures</p>"), BASE)).toBeUndefined();
    expect(heroImage(doc('<img src="/logo.png" width="200">'), BASE)).toBeUndefined();
  });

  it("reads lazy loading and fetchpriority as written, in any case", () => {
    const lazy = heroImage(doc('<img src="/a.jpg" width="900" loading="LAZY">'), BASE);
    expect(lazy).toMatchObject({ lazy: true, priorityHigh: false });
    const high = heroImage(doc('<img src="/a.jpg" width="900" fetchpriority="High">'), BASE);
    expect(high).toMatchObject({ lazy: false, priorityHigh: true });
  });

  it("sees a preload of the image by address, relative or absolute, or by its imagesrcset", () => {
    for (const head of [
      '<link rel="preload" as="image" href="/a.jpg">',
      '<link rel="preload" as="image" href="https://quillfeather.example/a.jpg">',
      '<link rel="preload" as="image" imagesrcset="/a.jpg 1x, /b.jpg 2x">',
    ])
      expect(heroImage(doc('<img src="/a.jpg" width="900">', head), BASE)?.preloaded).toBe(true);
    expect(
      heroImage(
        doc('<img src="/a.jpg" width="900">', '<link rel="preload" as="image" href="/b.jpg">'),
        BASE,
      )?.preloaded,
    ).toBe(false);
    expect(
      heroImage(
        doc('<img src="/a.jpg" width="900">', '<link rel="preload" as="script" href="/a.jpg">'),
        BASE,
      )?.preloaded,
    ).toBe(false);
  });

  it("reads the width the image is asked for: a width parameter, or a Next.js image address", () => {
    expect(heroImage(doc('<img src="/a.jpg?w=3840" width="800">'), BASE)?.requestedWidth).toBe(
      3840,
    );
    expect(
      heroImage(doc('<img src="/_next/image?url=%2Fa.jpg&w=3840" width="800">'), BASE)
        ?.requestedWidth,
    ).toBe(3840);
    expect(heroImage(doc('<img src="/a.jpg" width="800">'), BASE)?.requestedWidth).toBeUndefined();
  });

  it("knows an image that has a srcset", () => {
    expect(
      heroImage(
        doc('<img src="/a.jpg" srcset="/a-800.jpg 800w, /a-1600.jpg 1600w" width="800">'),
        BASE,
      )?.hasSrcset,
    ).toBe(true);
  });
});

describe("webglEvidence: a 3D scene is set up", () => {
  it("finds a 3D library by its script address", () => {
    for (const src of [
      "https://quillfeather.example/js/three.min.js",
      "https://cdn.example/three@0.160.0/build/three.module.js",
      "/assets/babylon.js",
      "/vendor/playcanvas-stable.min.js",
      "https://unpkg.example/@splinetool/runtime",
      "/js/react-three-fiber.js",
    ])
      expect(webglEvidence({ scripts: [src], code: [] }), src).toBeTruthy();
  });

  it("finds a WebGL call in code, and not the word in a sentence or an unrelated library", () => {
    expect(
      webglEvidence({
        scripts: [],
        code: ["const r = new THREE.WebGLRenderer({antialias:true});"],
      }),
    ).toBeTruthy();
    expect(webglEvidence({ scripts: [], code: ['canvas.getContext("webgl2")'] })).toBeTruthy();
    expect(
      webglEvidence({ scripts: [], code: ["canvas.getContext('experimental-webgl')"] }),
    ).toBeTruthy();
    expect(
      webglEvidence({ scripts: [], code: ["// we love three-part harmony and webgl is great"] }),
    ).toBeUndefined();
    expect(
      webglEvidence({ scripts: ["/js/jquery.min.js", "/js/three-way-toggle.js"], code: [] }),
    ).toBeUndefined();
    expect(webglEvidence({ scripts: [], code: ['canvas.getContext("2d")'] })).toBeUndefined();
  });
});

describe("startGate: the page waits for the visitor", () => {
  it("sees words that ask for a click, tap or press before something starts", () => {
    for (const t of [
      "Click to start the tour",
      "Tap anywhere to explore",
      "Press play to begin",
      "click here to enter the shop",
      "TAP TO ENTER",
    ])
      expect(startGate(t), t).toBe(true);
  });
  it("does not see a sentence that merely uses the words", () => {
    for (const t of [
      "Click the link below for the menu.",
      "We start baking at five.",
      "Press enquiries: ask at the counter.",
    ])
      expect(startGate(t), t).toBe(false);
  });
});

describe("heavyMotionKinds: what makes a page heavy for a small phone", () => {
  it("names a 3D scene, an autoplaying video and an animation library", () => {
    expect(
      heavyMotionKinds({
        html: '<video autoplay muted loop src="/a.mp4"></video>',
        scripts: ["/js/gsap.min.js", "/js/three.min.js"],
        code: [],
      }),
    ).toEqual(["3D scene", "autoplaying video", "animation library"]);
  });
  it("is empty for a plain page, a video that waits for a click and a video with no autoplay", () => {
    expect(
      heavyMotionKinds({ html: '<video controls src="/a.mp4"></video>', scripts: [], code: [] }),
    ).toEqual([]);
    expect(heavyMotionKinds({ html: "<p>hello</p>", scripts: ["/js/app.js"], code: [] })).toEqual(
      [],
    );
  });
});

describe("hasLowEndFallback: the page looks at the visitor's data saver or device", () => {
  it("finds Save-Data, device memory, core count and connection type in code, and the data-saving media query in CSS", () => {
    for (const code of [
      "if (navigator.connection && navigator.connection.saveData) skip();",
      "const low = navigator.deviceMemory < 4;",
      "if (navigator.hardwareConcurrency <= 2) lite();",
      "navigator.connection.effectiveType === '2g'",
      "@media (prefers-reduced-data: reduce) { .hero { display:none } }",
      "headers.get('Save-Data')",
    ])
      expect(hasLowEndFallback([code]), code).toBe(true);
  });
  it("is false for code that reads none of them, and does not take reduced motion for a data saver", () => {
    expect(hasLowEndFallback(["window.addEventListener('resize', draw);"])).toBe(false);
    expect(
      hasLowEndFallback(["@media (prefers-reduced-motion: reduce) { * { animation: none } }"]),
    ).toBe(false);
  });
});

describe("animatedLayoutProperties: keyframes that move layout", () => {
  it("names the layout properties a keyframes rule animates, once each", () => {
    const css =
      "@keyframes slide { from { left: 0; width: 10px } to { left: 100px; width: 50px; opacity: 1 } }";
    expect(animatedLayoutProperties(css)).toEqual(["left", "width"]);
  });
  it("leaves transform and opacity alone, and a layout property outside keyframes", () => {
    expect(
      animatedLayoutProperties(
        "@keyframes fade { from { opacity: 0; transform: translateX(0) } to { opacity: 1; transform: translateX(10px) } }",
      ),
    ).toEqual([]);
    expect(animatedLayoutProperties(".box { width: 10px; left: 4px }")).toEqual([]);
  });
  it("sees a transition on all and one on a layout property", () => {
    expect(animatedLayoutProperties(".a { transition: all 0.3s ease }")).toEqual(["all"]);
    expect(animatedLayoutProperties(".a { transition: height 0.3s, opacity 1s }")).toEqual([
      "height",
    ]);
    expect(animatedLayoutProperties(".a { transition: transform 0.3s }")).toEqual([]);
  });
});

describe("layoutThrashLoops: an animation loop that reads layout and then writes it", () => {
  it("finds a requestAnimationFrame function that reads a layout value and sets a style", () => {
    const code = `function tick(){ const w = el.offsetWidth; el.style.left = (w + 1) + "px"; requestAnimationFrame(tick); } requestAnimationFrame(tick);`;
    expect(layoutThrashLoops([code])).toBe(1);
  });
  it("finds the read through getBoundingClientRect and getComputedStyle, and the write through style.cssText or setProperty", () => {
    expect(
      layoutThrashLoops([
        `requestAnimationFrame(() => { const r = el.getBoundingClientRect(); el.style.height = r.height + 'px'; });`,
      ]),
    ).toBe(1);
    expect(
      layoutThrashLoops([
        `const loop = () => { const s = getComputedStyle(a).width; b.style.setProperty("width", s); requestAnimationFrame(loop); };`,
      ]),
    ).toBe(1);
  });
  it("leaves a loop that only writes, one that only reads, and a read with no loop", () => {
    expect(
      layoutThrashLoops([
        `requestAnimationFrame(() => { el.style.transform = "translateX(1px)"; });`,
      ]),
    ).toBe(0);
    expect(layoutThrashLoops([`requestAnimationFrame(() => { log(el.offsetWidth); });`])).toBe(0);
    expect(layoutThrashLoops([`const w = el.offsetWidth; el.style.width = w + "px";`])).toBe(0);
  });
  it("counts a thrashing loop once per script text and ignores very long minified lines safely", () => {
    const big = "x".repeat(300_000);
    expect(layoutThrashLoops([big, big])).toBe(0);
  });
});
