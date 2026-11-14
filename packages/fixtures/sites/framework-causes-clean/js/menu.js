// An invented script: it reads a layout value and writes a style, but not in an animation loop.
const banner = document.querySelector(".banner");
banner.style.minWidth = banner.offsetWidth + "px";
