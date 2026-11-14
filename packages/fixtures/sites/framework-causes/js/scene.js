// An invented scene script: it sets the renderer up at load and moves a box every frame.
const box = document.querySelector(".banner");
const renderer = new THREE.WebGLRenderer({ antialias: true });
function tick() {
  const width = box.offsetWidth;
  box.style.left = (width / 8) + "px";
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
