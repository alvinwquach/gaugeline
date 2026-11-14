// Run by send.test.ts in a child process that is started with Node's env proxy on and the proxy variables already
// set to a local proxy the test owns. Prints one JSON line: what the sender did when the name resolves to a private
// address. The proxy and its hit count live in the test, not here.
import { createCommentSender } from "../send.ts";

let lookups = 0;
const send = createCommentSender({
  resolve: (_host, _options, cb) => {
    lookups += 1;
    cb(null, [{ address: "10.1.2.3", family: 4 }]);
  },
});
const result = await send({
  token: "demo-token-A1b2C3d4E5f6G7h8I9j0",
  target: { owner: "brightside-studio", repo: "site", pullNumber: 1 },
  body: "hello",
});
console.log(JSON.stringify({ ...result, lookups }));
process.exit(0);
