import { describe, expect, it } from "vitest";
import type { CheckContext } from "../../model.js";
import type { RenderResult } from "../../render/types.js";
import { emptyBlocked } from "../../render/types.js";
import type { ScriptRead } from "../../scripts.js";
import { createPageRegistry } from "../index.js";
import {
  perfAnimationReflow,
  perfLcpImage,
  perfNoLowendFallback,
  perfWebglAutostart,
  PERF_CAUSE_CHECKS,
} from "../perf-causes.js";
import { page } from "./helpers.js";

const HOME = "https://quillfeather.example/";

function doc(body: string, head = ""): string {
  return `<!doctype html><html><head><title>Quillfeather</title>${head}</head><body>${body}</body></html>`;
}

function site(
  html: string,
  over: { scripts?: string[]; inline?: string[] } = {},
  ctxOver: Partial<CheckContext> = {},
) {
  const notes: { url: string; reason: string }[] = [];
  const snap = page({
    finalUrl: HOME,
    hops: [{ url: HOME, status: 200, headers: { "content-type": "text/html" }, ms: 1, body: html }],
    scripts: over.scripts ?? [],
    scriptTags: (over.inline ?? []).map((inline, position) => ({ inline, position })),
  });
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...ctxOver,
  };
  return { snap, ctx, notes };
}

const read = (text: string, over: Partial<ScriptRead> = {}): ScriptRead => ({
  url: `${HOME}app.js`,
  status: 200,
  text,
  truncated: false,
  ...over,
});
const withScripts = (...r: ScriptRead[]): Partial<CheckContext> => ({
  scripts: () => Promise.resolve(r),
});

const rendered = (html: string): RenderResult => ({
  kind: "rendered",
  finalUrl: HOME,
  status: 200,
  title: "Quillfeather" as never,
  html: html as never,
  requests: [],
  blocked: emptyBlocked(),
  totals: { requests: 1, bytes: 1 },
  truncated: [],
});

describe("the four framework-cause checks: shape", () => {
  it("are four, each with its words, in the default registry", () => {
    expect(PERF_CAUSE_CHECKS.map((c) => c.id)).toEqual([
      "perf-webgl-autostart",
      "perf-lcp-image",
      "perf-animation-reflow",
      "perf-no-lowend-fallback",
    ]);
    const reg = createPageRegistry();
    for (const c of PERF_CAUSE_CHECKS) {
      expect(reg.has(c.id), c.id).toBe(true);
      expect(c.what && c.why && c.fix && c.tech, c.id).toBeTruthy();
    }
  });

  it("say nothing about a page that is not HTML", async () => {
    const s = site("{}", {}, {});
    const json = {
      ...s.snap,
      hops: [{ ...s.snap.hops[0]!, headers: { "content-type": "application/json" } }],
    };
    for (const c of PERF_CAUSE_CHECKS) expect(await c.run(json, s.ctx), c.id).toEqual([]);
  });
});

describe("perf-webgl-autostart", () => {
  const scene = doc(
    "<main><h1>Quillfeather</h1><canvas id='scene' width='1280' height='720'></canvas></main>",
    "",
  );
  it("finds a 3D scene that is set up at load with no click, tap or start step", async () => {
    const s = site(scene, { scripts: [`${HOME}js/three.min.js`] });
    const out = await perfWebglAutostart.run(s.snap, s.ctx);
    expect(out).toEqual([
      {
        checkId: "perf-webgl-autostart",
        severity: "medium",
        title: perfWebglAutostart.title,
        evidence:
          'A 3D scene starts as soon as the page loads: three.min.js is loaded and the page has a canvas, and no "click to start" or "tap to enter" step was found, so every visitor pays for it before any input.',
        url: HOME,
      },
    ]);
  });

  it("finds it from inline code too", async () => {
    const s = site(scene, { inline: ["const r = new THREE.WebGLRenderer({ canvas });"] });
    expect(await perfWebglAutostart.run(s.snap, s.ctx)).toHaveLength(1);
  });

  it("is quiet when the page asks the visitor to start it", async () => {
    const s = site(doc("<canvas></canvas><p>Click to start the tour</p>"), {
      scripts: ["/js/three.min.js"],
    });
    expect(await perfWebglAutostart.run(s.snap, s.ctx)).toEqual([]);
  });

  it("is quiet with no 3D library, and with a library but no canvas anywhere", async () => {
    const nolib = site(scene);
    expect(await perfWebglAutostart.run(nolib.snap, nolib.ctx)).toEqual([]);
    const s = site(doc("<p>Hello</p>"), { scripts: ["/js/three.min.js"] });
    expect(await perfWebglAutostart.run(s.snap, s.ctx)).toEqual([]);
  });

  it("with a renderer, goes by the canvas in the rendered page, and says its size", async () => {
    const s = site(
      doc("<div id='app'></div>"),
      { scripts: ["/js/three.min.js"] },
      {
        render: () => Promise.resolve(rendered(doc("<canvas width='1280' height='720'></canvas>"))),
      },
    );
    const out = await perfWebglAutostart.run(s.snap, s.ctx);
    expect(out[0]?.evidence).toContain("a canvas of 1280 by 720 in the rendered page");
  });

  it("with a renderer that finds no canvas, a library alone is not reported", async () => {
    const s = site(
      scene,
      { scripts: ["/js/three.min.js"] },
      {
        render: () => Promise.resolve(rendered(doc("<p>No scene</p>"))),
      },
    );
    expect(await perfWebglAutostart.run(s.snap, s.ctx)).toEqual([]);
  });

  it("with a renderer that cannot render, goes by the page as sent", async () => {
    const s = site(
      scene,
      { scripts: ["/js/three.min.js"] },
      {
        render: () =>
          Promise.resolve({ kind: "could-not-check", reason: "no browser" } as RenderResult),
      },
    );
    expect(await perfWebglAutostart.run(s.snap, s.ctx)).toHaveLength(1);
  });
});

describe("perf-lcp-image", () => {
  const img = (attrs: string, head = "") =>
    site(
      doc(
        `<header><a href="/">Home</a></header><main><img src="/loaves.jpg" ${attrs}></main>`,
        head,
      ),
    );

  it("finds a first large image that is lazy-loaded, as a medium finding", async () => {
    const s = img('width="1200" height="800" loading="lazy"');
    const out = await perfLcpImage.run(s.snap, s.ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "medium",
        "The first large image, https://quillfeather.example/loaves.jpg, is lazy-loaded, so the browser waits to fetch it: it is probably what the page's largest paint waits for.",
      ],
    ]);
  });

  it("finds one that is neither preloaded nor marked high priority, as a low finding", async () => {
    const plain = img('width="1200" height="800"');
    const out = await perfLcpImage.run(plain.snap, plain.ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "low",
        'The first large image, https://quillfeather.example/loaves.jpg, is not preloaded and has no fetchpriority="high", so the browser finds it late: it is probably what the page\'s largest paint waits for.',
      ],
    ]);
  });

  it("is quiet when the image is marked high priority or preloaded", async () => {
    for (const s of [
      img('width="1200" fetchpriority="high"'),
      img('width="1200"', '<link rel="preload" as="image" href="/loaves.jpg">'),
    ])
      expect(await perfLcpImage.run(s.snap, s.ctx)).toEqual([]);
  });

  it("finds an image asked for at twice the width it is shown, or at 2560 or more with no width", async () => {
    const wide = site(doc('<img src="/loaves.jpg?w=3840" width="800" fetchpriority="high">'));
    const out = await perfLcpImage.run(wide.snap, wide.ctx);
    expect(out[0]?.evidence).toContain("is asked for at 3840 pixels wide but shown 800 wide");
    const nowidth = site(doc('<img src="/loaves.jpg?w=2560" fetchpriority="high">'));
    expect((await perfLcpImage.run(nowidth.snap, nowidth.ctx))[0]?.evidence).toContain(
      "2560 pixels wide",
    );
    const ok = site(doc('<img src="/loaves.jpg?w=1200" width="800" fetchpriority="high">'));
    expect(await perfLcpImage.run(ok.snap, ok.ctx)).toEqual([]);
  });

  it("reports every problem of the one image in a single finding, worst first", async () => {
    const s = site(doc('<img src="/loaves.jpg?w=3840" width="800" loading="lazy">'));
    const out = await perfLcpImage.run(s.snap, s.ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("medium");
    expect(out[0]?.evidence).toMatch(/lazy-loaded.*asked for at 3840/s);
  });

  it("has nothing to say when there is no large content image", async () => {
    const s = site(doc("<p>Hello</p>"));
    expect(await perfLcpImage.run(s.snap, s.ctx)).toEqual([]);
  });
});

describe("perf-animation-reflow", () => {
  it("finds keyframes and transitions that animate layout, in the page's own styles", async () => {
    const s = site(
      doc(
        "<p>Hi</p>",
        "<style>@keyframes slide { from { left: 0 } to { left: 90px } } .a { transition: all .3s }</style>",
      ),
    );
    const out = await perfAnimationReflow.run(s.snap, s.ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "low",
        "The page's own styles animate layout properties (left, all), so each frame makes the browser lay the page out again. Stylesheets in separate files are not read.",
      ],
    ]);
  });

  it("finds an animation loop that reads layout and writes a style, as medium", async () => {
    const code =
      "function tick(){ const w = el.offsetWidth; el.style.left = w + 'px'; requestAnimationFrame(tick); }";
    const s = site(doc("<p>Hi</p>"), { inline: [code] });
    const out = await perfAnimationReflow.run(s.snap, s.ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("medium");
    expect(out[0]?.evidence).toContain(
      "1 script has an animation loop that reads a layout value and then sets a style",
    );
  });

  it("counts the loop in a same-site script file and the page's inline script once each", async () => {
    const code =
      "requestAnimationFrame(() => { const r = el.getBoundingClientRect(); el.style.height = r.height + 'px'; });";
    const s = site(doc("<p>Hi</p>"), { inline: [code] }, withScripts(read(code)));
    const out = await perfAnimationReflow.run(s.snap, s.ctx);
    expect(out[0]?.evidence).toContain("2 scripts have an animation loop");
  });

  it("is quiet for transform and opacity animations and loops that only write", async () => {
    const s = site(
      doc(
        "<p>Hi</p>",
        "<style>@keyframes fade { from { opacity: 0; transform: scale(1) } to { opacity: 1; transform: scale(2) } }</style>",
      ),
      { inline: ["requestAnimationFrame(() => { el.style.transform = 'translateX(1px)'; });"] },
    );
    expect(await perfAnimationReflow.run(s.snap, s.ctx)).toEqual([]);
  });

  it("says a script that could not be read is could-not-check, and still reports what it can see", async () => {
    const s = site(
      doc("<p>Hi</p>", "<style>.a { transition: height 1s }</style>"),
      {},
      withScripts(read("", { status: null })),
    );
    const out = await perfAnimationReflow.run(s.snap, s.ctx);
    expect(out).toHaveLength(1);
    expect(s.notes[0]?.reason).toContain("could not be read");
  });
});

describe("perf-no-lowend-fallback", () => {
  const heavy = (
    extra: Partial<Parameters<typeof site>[1]> = {},
    ctx: Partial<CheckContext> = {},
  ) => site(doc("<canvas></canvas>"), { scripts: ["/js/three.min.js"], ...extra }, ctx);

  it("finds a heavy page that never looks at the visitor's data saver or device", async () => {
    const s = heavy({}, withScripts(read("window.addEventListener('resize', draw);")));
    const out = await perfNoLowendFallback.run(s.snap, s.ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "low",
        "The page loads a 3D scene and nothing in its own scripts or styles reads the visitor's data saver (Save-Data), device memory, core count or connection type, so a small phone on a slow connection gets the same heavy load as a desktop. Scripts from other sites are not read.",
      ],
    ]);
  });

  it("names every heavy thing, in a fixed order", async () => {
    const s = site(
      doc('<video autoplay muted src="/a.mp4"></video>'),
      { scripts: ["/js/three.min.js", "/js/gsap.min.js"] },
      withScripts(read("x")),
    );
    const out = await perfNoLowendFallback.run(s.snap, s.ctx);
    expect(out[0]?.evidence).toContain("a 3D scene, an autoplaying video and an animation library");
  });

  it("is quiet when the page's own code reads Save-Data, memory, cores or the connection", async () => {
    for (const code of [
      "if (navigator.connection?.saveData) lite();",
      "navigator.deviceMemory < 4",
      "navigator.hardwareConcurrency",
      "navigator.connection.effectiveType",
    ]) {
      const s = heavy({}, withScripts(read(code)));
      expect(await perfNoLowendFallback.run(s.snap, s.ctx), code).toEqual([]);
    }
    const css = heavy({}, withScripts(read("x")));
    expect(await perfNoLowendFallback.run(css.snap, css.ctx)).toHaveLength(1);
  });

  it("is quiet for an ordinary page", async () => {
    const s = site(doc("<p>Hi</p>"), { scripts: ["/js/app.js"] });
    expect(await perfNoLowendFallback.run(s.snap, s.ctx)).toEqual([]);
  });

  it("is could-not-check, not a finding, when a script of the site could not be read or was cut", async () => {
    for (const bad of [read("", { status: null }), read("x", { truncated: true })]) {
      const s = heavy({}, withScripts(bad));
      expect(await perfNoLowendFallback.run(s.snap, s.ctx)).toEqual([]);
      expect(s.notes[0]?.reason).toMatch(/could not be read|only its start/);
    }
  });
});
