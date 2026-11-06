# qr

Three invented QR codes for the printed links check (N08). Nothing here is a real business; the
addresses are on `copperkettle.example`, an invented tavern.

- `table-tent.png`: `https://copperkettle.example/table-menu?utm_source=table-tent&utm_medium=qr`
  (RGB, 8-bit).
- `spring-flyer.png`: `https://copperkettle.example/spring-flyer` (RGBA, 8-bit).
- `blurred-flyer.png`: `https://copperkettle.example/events?utm_source=flyer`, blurred until no
  decoder can read it: the "could not be checked" case.

Made with the `qrcode` npm package (1.5.4, `width: 240, margin: 4`) and blurred with a Gaussian
blur of radius 9. Neither tool is a dependency of this repository; the images are committed.
