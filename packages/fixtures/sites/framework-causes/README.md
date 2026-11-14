# framework-causes

An invented bakery (Quillfeather Bakery) whose page has the four things a framework tends to leave behind, for
the framework-cause checks (PERF-03). Nothing here is a real business or person.

- `perf-webgl-autostart`: a canvas, a 3D library and `new THREE.WebGLRenderer` set up at load, with no start step.
- `perf-lcp-image`: the first large image is `loading="lazy"` and asked for at 3840 pixels for an 800 pixel slot.
- `perf-animation-reflow`: a keyframes rule animates `left`, and `js/scene.js` reads `offsetWidth` and sets
  `style.left` inside a `requestAnimationFrame` loop.
- `perf-no-lowend-fallback`: a 3D scene and an autoplaying video, and nothing reads Save-Data, device memory,
  core count or connection type.

The passing copy is `framework-causes-clean`.
