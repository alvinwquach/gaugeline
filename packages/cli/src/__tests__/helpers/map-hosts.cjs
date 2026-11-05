// Loaded with node --require (through NODE_OPTIONS) into the built CLI, for tests only. Maps
// logical fixture hosts to local ports, the way the fetcher's `hosts` option does in-process and
// curl --resolve does on the command line. GAUGELINE_TEST_HOSTS is JSON: {"shop.test": "127.0.0.1:41234"}.
// Names not in the map resolve and connect as normal.
const dnsPromises = require("node:dns/promises");
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");

const map = JSON.parse(process.env.GAUGELINE_TEST_HOSTS || "{}");
const target = (host) => map[String(host || "").toLowerCase()];

const originalLookup = dnsPromises.lookup;
// GAUGELINE_TEST_OFFLINE=1: a host that is neither mapped nor an IP address does not resolve, so a
// test run can never reach the live internet (a payment or store link on a fixture page, say).
const offline = process.env.GAUGELINE_TEST_OFFLINE === "1";
const isIp = (h) => /^[\d.]+$/.test(h) || h.includes(":");

dnsPromises.lookup = async function lookup(hostname, options) {
  const t = target(hostname);
  if (!t && offline && !isIp(String(hostname))) {
    const err = new Error(`getaddrinfo ENOTFOUND ${hostname} (offline test run)`);
    err.code = "ENOTFOUND";
    err.hostname = hostname;
    throw err;
  }
  if (!t) return originalLookup.call(this, hostname, options);
  const address = { address: t.split(":")[0], family: 4 };
  return options && options.all ? [address] : address;
};
// The CLI imports { lookup } from "node:dns/promises" as an ES module: update that binding too.
syncBuiltinESMExports();

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  // node:http calls this with its internal normalised [options, callback] array; keep that array
  // (it carries a marker symbol) and set the port on the options object it holds.
  const first = args[0];
  const opts = Array.isArray(first) ? first[0] : first;
  if (opts !== null && typeof opts === "object") {
    const t = target(opts.servername || opts.host);
    if (t) opts.port = Number(t.split(":")[1]);
  }
  return originalConnect.apply(this, args);
};

// GAUGELINE_TEST_NOW (an ISO time) pins the clock, so date checks give the same answer every run.
if (process.env.GAUGELINE_TEST_NOW) {
  const fixed = Date.parse(process.env.GAUGELINE_TEST_NOW);
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate;
}
