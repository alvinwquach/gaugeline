# solidstart-like

An invented coffee cart that looks like a SolidStart site from the outside (the `_$HY` hydration
bootstrap, serialized data written to `_$HY.r`, `data-hk` attributes, `/_build/assets/` modules, a
`"use server"` form posting to `/_server`), for the Qwik and SolidStart checks (FW-07). Nothing here
is a real business. The structure is the one solid-js 1.9.19 and @solidjs/start 1.5.1 write.

- The hydration data holds `adminPassword`: `qwik-solid-private-fields`.
- The form posts to `/_server?id=...&name=...`: `qwik-solid-server-endpoints`.
