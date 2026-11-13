// Run by send.test.ts in a child process with Node's env proxy switched on. Prints one JSON line: what the
// sender did when the proxy variables point at a local proxy and the name resolves to a private address.
import { createServer } from "node:http";
import { createProviderAdapter } from "../send.ts";
import { ApiKey } from "../key.ts";

const hits = [];
const proxy = createServer();
proxy.on("connect", (req, socket) => {
  hits.push(req.url);
  socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
});
proxy.on("request", (req, res) => {
  hits.push(req.url);
  res.writeHead(502).end();
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`;
process.env.https_proxy = process.env.HTTPS_PROXY;

let lookups = 0;
const adapter = createProviderAdapter("example", {
  resolve: (_host, _options, cb) => {
    lookups += 1;
    cb(null, [{ address: "10.1.2.3", family: 4 }]);
  },
});
let result;
try {
  await adapter.complete({
    model: "m",
    prompt: "hi",
    callId: "c",
    maxOutputTokens: 5,
    signal: new globalThis.AbortController().signal,
    key: new ApiKey("demo-value-A1b2C3d4E5f6G7h8I9j0"),
  });
  result = { answered: true };
} catch (e) {
  result = { code: e.code, message: e.message };
}
console.log(JSON.stringify({ ...result, lookups, proxyHits: hits }));
proxy.close();
process.exit(0);
