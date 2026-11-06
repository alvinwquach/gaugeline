// Loaded before every test file (vitest setupFiles). Names reserved for examples and tests
// (RFC 2606, RFC 6761) never reach the machine's resolver: a fixture host that isn't mapped, or a
// derived name such as staging.<fixture>.test, fails the way an unknown name does, offline.
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const RESERVED = /(?:^|\.)(?:example|test|invalid)\.?$|(?:^|\.)example\.(?:com|net|org)\.?$/i;
const lookup = dns.lookup.bind(dns);

function notFound(hostname: string): Error {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname} (reserved name, test run)`), {
    code: "ENOTFOUND",
    hostname,
  });
}

dns.lookup = (async (hostname: string, options?: unknown) => {
  if (RESERVED.test(hostname)) throw notFound(hostname);
  return lookup(hostname, options as never);
}) as typeof dns.lookup;
syncBuiltinESMExports();
