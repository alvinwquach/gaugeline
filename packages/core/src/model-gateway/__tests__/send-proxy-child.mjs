// Run by send.test.ts in a child process that is started with Node's env proxy on and the proxy variables already
// set to a local proxy the test owns. Prints one JSON line: what the sender did when the name resolves to a private
// address. The proxy and its hit count live in the test, not here.
import { createProviderAdapter } from "../send.ts";
import { ApiKey } from "../key.ts";

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
console.log(JSON.stringify({ ...result, lookups }));
process.exit(0);
