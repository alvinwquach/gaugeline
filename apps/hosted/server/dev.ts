/**
 * Development server: `pnpm --filter @gaugeline/hosted dev` with the variables listed in lib/web/deps.ts.
 * Refuses to start on a database login that skips row-level security. Listens on 127.0.0.1 only.
 */
import type { AddressInfo } from "node:net";
import { buildDeps } from "../lib/web/deps.js";
import { createWebServer } from "./node.js";

const deps = await buildDeps(process.env);
const port = Number(process.env.PORT ?? 3000);
let origin = "";
const server = createWebServer(deps, () => origin);
server.listen(port, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`Gaugeline hosted (development) at ${origin}`);
});
