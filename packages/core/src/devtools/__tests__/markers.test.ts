import { describe, expect, it } from "vitest";
import { findDevMarkers, scriptAddressMarkers } from "../markers.js";

const ids = (text: string, own?: string) => findDevMarkers(text, own).map((m) => m.id);

describe("dev markers: what a production page or bundle should not hold", () => {
  it("Vite and React Refresh development addresses", () => {
    expect(ids('<script type="module" src="/@vite/client"></script>')).toEqual(["vite-client"]);
    expect(ids('import R from "/@react-refresh";')).toEqual(["react-refresh"]);
  });

  it("webpack dev server, hot middleware, eval source names and the Next development build", () => {
    expect(ids('new EventSource("/__webpack_hmr")')).toEqual(["webpack-hmr"]);
    expect(ids('import "webpack-dev-server/client/index.js"')).toEqual(["webpack-dev-server"]);
    expect(ids('eval("x\\n//# sourceURL=webpack-internal:///./src/a.js")')).toEqual([
      "webpack-eval",
    ]);
    expect(ids('<script src="/_next/static/development/_buildManifest.js">')).toEqual([
      "next-development",
    ]);
    expect(ids('{"props":{},"buildId":"development","page":"/"}')).toEqual(["next-development"]);
    expect(ids('{"buildId":"Zk3x9QwB7"}')).toEqual([]);
  });

  it("a development build of React, and NODE_ENV set to development", () => {
    expect(
      ids("Download the React DevTools for a better development experience: https://x"),
    ).toEqual(["react-development"]);
    expect(ids('define({"process.env":{NODE_ENV:"development"}})')).toEqual(["node-env"]);
    expect(ids('process.env.NODE_ENV="development"')).toEqual(["node-env"]);
    // A test, not an assignment: production bundles are full of these.
    expect(ids('if(process.env.NODE_ENV==="development"){}')).toEqual([]);
    expect(ids('NODE_ENV:"production"')).toEqual([]);
  });

  it("an address on the machine the code runs on, with a port, is named by host and port only", () => {
    const m = findDevMarkers('fetch("http://127.0.0.1:4010/api/orders?token=abc")');
    expect(m).toEqual([{ id: "loopback-address", detail: "127.0.0.1:4010", serves: false }]);
    expect(
      ids('const a="http://localhost:3000"; b="ws://0.0.0.0:5173/"; c="https://[::1]:8443"'),
    ).toEqual(["loopback-address", "loopback-address", "loopback-address"]);
  });

  it("leaves out loopback with no port (libraries use it as a base), and the page's own origin", () => {
    expect(ids('new URL(x, "http://localhost")')).toEqual([]);
    expect(ids('<a href="http://127.0.0.1:8080/">', "http://127.0.0.1:8080")).toEqual([]);
    expect(ids('<a href="http://127.0.0.1:8080/">', "http://127.0.0.1:9000")).toEqual([
      "loopback-address",
    ]);
  });

  it("script addresses: a development build of a library served as a file", () => {
    expect(
      scriptAddressMarkers([
        "https://cdn.example/react-dom.development.js",
        "https://cdn.example/react.development.min.js?v=1",
        "https://cdn.example/react.production.min.js",
      ]).map((m) => m.id),
    ).toEqual(["react-development", "react-development"]);
  });

  it("nothing for a clean page, and hostile megabyte input is scanned in linear time", () => {
    expect(ids("<html><body>Fresh bread</body></html>")).toEqual([]);
    const hostile = "http://127.0.0.1:".repeat(150_000) + "NODE_ENV=".repeat(150_000);
    const t = Date.now();
    findDevMarkers(hostile);
    expect(Date.now() - t).toBeLessThan(1500);
  });
});
